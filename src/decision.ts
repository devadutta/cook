import {
  createGateway,
  experimental_decide as decide,
  type Experimental_DecisionResult as DecisionResult,
  type Experimental_DecisionState as DecisionState,
  type Experimental_DecisionStatePart as DecisionStatePart,
} from 'ai-v7';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decision_questions_schema, type DecisionQuestions } from './config.ts';
import { CliError } from './errors.ts';
import type { RuntimeConfig, SessionLogger, StdinContext } from './types.ts';

// Loaded only for agents with "type": "decision", and embedded as its own
// entrypoint in compiled builds: it brings a second copy of the AI SDK (v7,
// which added decision models) that `cook <instruction>` should never load.

type DecisionInput =
  | { kind: 'request'; questions: unknown; state?: unknown }
  | { kind: 'state'; state: DecisionState };

export interface DecisionRequest {
  state: DecisionState;
  questions: DecisionQuestions;
  /** Question files named with @name, in the order given. */
  questionFiles: string[];
}

export interface DecisionRunOptions {
  instruction: string;
  runtime: RuntimeConfig;
  stdin: StdinContext;
  json: boolean;
  logDebug: (message: string) => void;
  sessionLogger?: SessionLogger;
  abortSignal?: AbortSignal;
  fetch?: typeof fetch;
  homeDir?: string;
}

const PART_TYPES = new Set(['text', 'file', 'json']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStateParts(value: unknown[]): value is DecisionStatePart[] {
  return value.length > 0 && value.every(part => isPlainObject(part) && PART_TYPES.has(String(part.type)));
}

/** Text, a JSON object, or AI SDK state parts; other JSON goes in as one json part. */
function toState(value: unknown): DecisionState {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return isStateParts(value) ? value : [{ type: 'json', value }];
  }
  if (isPlainObject(value)) {
    return value as DecisionState;
  }
  return String(value);
}

// Array.isArray does not narrow readonly arrays.
function isPartList(state: DecisionState): state is readonly DecisionStatePart[] {
  return Array.isArray(state);
}

function toParts(state: DecisionState): DecisionStatePart[] {
  if (typeof state === 'string') {
    return [{ type: 'text', text: state }];
  }
  return isPartList(state) ? [...state] : [{ type: 'json', value: state }];
}

/** A JSON object with "questions" is a whole request; anything else is state. */
function parseInput(text: string): DecisionInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'state', state: text.trim() };
  }

  if (isPlainObject(parsed) && 'questions' in parsed) {
    return { kind: 'request', questions: parsed.questions, state: parsed.state };
  }
  return { kind: 'state', state: typeof parsed === 'object' && parsed !== null ? toState(parsed) : text.trim() };
}

export function detectImageType(bytes: Uint8Array): string | undefined {
  const startsWith = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  if (startsWith(0x89, 0x50, 0x4e, 0x47)) {
    return 'image/png';
  }
  if (startsWith(0xff, 0xd8, 0xff)) {
    return 'image/jpeg';
  }
  if (startsWith(0x47, 0x49, 0x46, 0x38)) {
    return 'image/gif';
  }
  if (startsWith(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') {
    return 'image/webp';
  }
  return undefined;
}

async function readStdinInput(stdin: StdinContext): Promise<DecisionInput | undefined> {
  if (stdin.mode === 'none') {
    return undefined;
  }

  if (stdin.isText) {
    const text = stdin.inlineText ?? await Bun.file(stdin.tempFilePath ?? '').text();
    return text.trim() ? parseInput(text) : undefined;
  }

  const bytes = await Bun.file(stdin.tempFilePath ?? '').bytes();
  const mediaType = detectImageType(bytes);
  if (!mediaType) {
    throw new CliError('Binary stdin must be a PNG, JPEG, GIF or WebP image.');
  }
  return { kind: 'state', state: [{ type: 'file', mediaType, data: bytes }] };
}

function parseQuestions(value: unknown, source?: string): DecisionQuestions {
  const result = decision_questions_schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .map(issue => `${(source ? issue.path : ['questions', ...issue.path]).join('.') || '<root>'}: ${issue.message}`)
      .join(', ');
    throw new CliError(`Invalid decision questions${source ? ` in ${source}` : ''}: ${issues}`);
  }
  return result.data;
}

const QUESTION_REF = /^@([A-Za-z0-9][A-Za-z0-9._-]*)(?=\s|$)/;

/** Leading @name tokens name question files: "@asset-kind SPY" → ["asset-kind"], "SPY". */
export function splitQuestionRefs(instruction: string): { names: string[]; rest: string } {
  const names: string[] = [];
  let rest = instruction.trimStart();
  for (let match = QUESTION_REF.exec(rest); match?.[1]; match = QUESTION_REF.exec(rest)) {
    names.push(match[1].replace(/\.json$/, ''));
    rest = rest.slice(match[0].length).trimStart();
  }
  return { names, rest };
}

/** Like command aliases: the project's .cook/questions first, then ~/.cook/questions. */
function questionDirs(cwd: string, homeDir: string): string[] {
  return [path.join(cwd, '.cook', 'questions'), path.join(homeDir, '.cook', 'questions')];
}

async function jsonFilesIn(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => entry.name);
  } catch {
    return [];
  }
}

/** Reads each named file's questions and combines them; a question id may appear only once. */
async function loadQuestionFiles(
  names: string[],
  cwd: string,
  homeDir: string,
): Promise<{ questions: DecisionQuestions; files: string[] }> {
  const dirs = questionDirs(cwd, homeDir);
  const listings = await Promise.all(dirs.map(jsonFilesIn));
  const questions: DecisionQuestions = {};
  const files: string[] = [];

  for (const name of names) {
    // Exact names, so @Kind does not open kind.json on case-insensitive disks.
    const index = listings.findIndex(listing => listing.includes(`${name}.json`));
    if (index === -1) {
      const available = [...new Set(listings.flat())].map(file => `@${file.slice(0, -'.json'.length)}`);
      throw new CliError([
        `Questions "@${name}" not found. Expected ${name}.json in ${dirs.join(' or ')}.`,
        available.length > 0 ? `Available: ${available.sort().join(', ')}.` : undefined,
      ].filter(Boolean).join(' '));
    }

    const filePath = path.join(dirs[index] ?? '', `${name}.json`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await Bun.file(filePath).text());
    } catch (error) {
      throw new CliError(`${filePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const [id, question] of Object.entries(parseQuestions(parsed, filePath))) {
      if (id in questions) {
        throw new CliError(`Question "${id}" is defined in more than one of: ${names.map(item => `@${item}`).join(', ')}.`);
      }
      questions[id] = question;
    }
    files.push(filePath);
  }

  return { questions, files };
}

/**
 * Builds the request from the argument and stdin, in that order. Leading
 * @name tokens load question files; either input can also hold a full request
 * ({"state": …, "questions": {…}}). Everything else is state.
 */
export async function resolveDecisionRequest(options: {
  instruction: string;
  stdin: StdinContext;
  questions?: DecisionQuestions;
  cwd?: string;
  homeDir?: string;
}): Promise<DecisionRequest> {
  const { names, rest } = splitQuestionRefs(options.instruction);
  const loaded = names.length > 0
    ? await loadQuestionFiles(names, options.cwd ?? process.cwd(), options.homeDir ?? os.homedir())
    : undefined;
  const inputs = [
    rest.trim() ? parseInput(rest) : undefined,
    await readStdinInput(options.stdin),
  ].filter((input): input is DecisionInput => input !== undefined);

  let questions = loaded?.questions ?? options.questions;
  const states: DecisionState[] = [];
  for (const input of inputs) {
    if (input.kind === 'request') {
      questions = parseQuestions(input.questions);
      if (input.state !== undefined) {
        states.push(toState(input.state));
      }
    } else {
      states.push(input.state);
    }
  }

  if (!questions) {
    throw new CliError(
      'This decision agent has no questions. Start the input with @name to load .cook/questions/name.json, or pass {"state": …, "questions": {…}}.',
    );
  }
  const [first] = states;
  if (first === undefined) {
    throw new CliError('Missing input. Pass the state to decide on as an argument or on stdin.');
  }
  return {
    questions,
    state: states.length === 1 ? first : states.flatMap(toParts),
    questionFiles: loaded?.files ?? [],
  };
}

function formatProbability(value: number): string {
  return value.toFixed(2);
}

/** One line per question: the choice, score or P(true). */
export function formatDecisionAnswers(
  questions: DecisionQuestions,
  answers: DecisionResult<DecisionQuestions>['answers'],
): string {
  return Object.entries(questions).map(([id, question]) => {
    const answer = answers[id];
    switch (answer?.type) {
      case 'choice': {
        const probability = answer.probabilities?.[answer.choice];
        return `${id}: ${answer.choice}${probability === undefined ? '' : ` (${formatProbability(probability)})`}`;
      }
      case 'score': {
        const top = question.type === 'score' ? question.criteria.length - 1 : undefined;
        return `${id}: ${answer.score.toFixed(2)}${top === undefined ? '' : `/${top}`}`;
      }
      case 'boolean':
        return `${id}: ${formatProbability(answer.probability)}`;
      default:
        return `${id}: no answer`;
    }
  }).join('\n');
}

export function formatDecisionJson(result: DecisionResult<DecisionQuestions>): string {
  return JSON.stringify(
    { model: result.response.modelId, answers: result.answers, usage: result.usage },
    null,
    2,
  );
}

function parseJsonObject(text: unknown): Record<string, unknown> | undefined {
  if (typeof text !== 'string') {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Gateway rejections say "Invalid input" and list the offending fields in the
 * response body, or pass on the model's own error as a JSON string.
 */
export function describeDecisionError(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }

  const inner = parseJsonObject(error.message)?.message;
  if (typeof inner === 'string') {
    return inner;
  }

  const body = parseJsonObject((error.cause as { responseBody?: unknown } | undefined)?.responseBody);
  const params = isPlainObject(body?.error) ? body.error.param : undefined;
  const paths = Array.isArray(params)
    ? params.flatMap(param => (isPlainObject(param) && Array.isArray(param.path) ? [param.path.join('.')] : []))
    : [];
  return paths.length > 0 ? `${error.message} at ${paths.join(', ')}` : undefined;
}

function describeState(state: DecisionState): string {
  if (typeof state === 'string') {
    return 'text';
  }
  return Array.isArray(state) ? state.map(part => part.type).join('+') : 'json';
}

export async function runDecision(options: DecisionRunOptions): Promise<string> {
  const { runtime, logDebug, sessionLogger } = options;
  const apiKey = runtime.ai_gateway_api_key ?? process.env.AI_GATEWAY_API_KEY;
  if (!apiKey && !process.env.VERCEL_OIDC_TOKEN) {
    throw new CliError(
      'Decision agents run on the Vercel AI Gateway. Set AI_GATEWAY_API_KEY, or save the key with /keys in `cook`.',
    );
  }

  const request = await resolveDecisionRequest({
    instruction: options.instruction,
    stdin: options.stdin,
    questions: runtime.agent.questions,
    cwd: runtime.cwd,
    homeDir: options.homeDir,
  });
  const questionIds = Object.keys(request.questions);
  for (const file of request.questionFiles) {
    logDebug(`questions from ${file}`);
  }
  logDebug(`decision model=${runtime.agent.model} questions=${questionIds.join(',')} state=${describeState(request.state)}`);
  sessionLogger?.logEvent('agent.call.start', {
    mode: 'decision',
    model: runtime.agent.model,
    questions: request.questions,
    state: describeState(request.state),
  });

  const gateway = createGateway({ apiKey, fetch: options.fetch });
  const result = await decide({
    model: gateway.decisionModel(runtime.agent.model),
    state: request.state,
    questions: request.questions,
    abortSignal: options.abortSignal,
  }).catch((error: unknown) => {
    const message = describeDecisionError(error);
    throw message ? new Error(message, { cause: error }) : error;
  });

  logDebug(`decision answered by ${result.response.modelId} (input tokens: ${result.usage.inputTokens ?? 'unknown'})`);
  sessionLogger?.logEvent('agent.call.finish', {
    mode: 'decision',
    model: result.response.modelId,
    answers: result.answers,
    usage: result.usage,
  });

  return options.json ? formatDecisionJson(result) : formatDecisionAnswers(request.questions, result.answers);
}
