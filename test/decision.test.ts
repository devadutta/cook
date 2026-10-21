import { describe, expect, it } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DecisionQuestions } from '../src/config.ts';
import {
  describeDecisionError,
  detectImageType,
  formatDecisionAnswers,
  resolveDecisionRequest,
  runDecision,
  splitQuestionRefs,
} from '../src/decision.ts';
import type { RuntimeConfig, StdinContext } from '../src/types.ts';

const NO_STDIN: StdinContext = { mode: 'none', bytes: 0, isText: true, preview: '' };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const URGENT = { type: 'boolean', instructions: 'Is it urgent?' } as const;
const QUESTIONS: DecisionQuestions = {
  team: { type: 'choice', instructions: 'Which team', criteria: { billing: 'Invoices', technical: 'Bugs' } },
  severity: { type: 'score', instructions: 'How severe', criteria: ['Minor', 'Moderate', 'Critical'] },
  urgent: URGENT,
};

function textStdin(text: string): StdinContext {
  return { mode: 'inline', bytes: text.length, isText: true, preview: text, inlineText: text };
}

async function binaryStdin(bytes: Uint8Array): Promise<StdinContext> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cook-decision-test-'));
  const tempFilePath = path.join(dir, 'stdin.bin');
  await Bun.write(tempFilePath, bytes);
  return { mode: 'temp-file', bytes: bytes.length, isText: false, preview: '<binary stdin>', tempFilePath };
}

function decisionRuntime(overrides: Partial<RuntimeConfig['agent']> = {}): RuntimeConfig {
  return {
    max_steps: 12,
    bash_timeout_ms: 30_000,
    bash_output_limit_bytes: 1_048_576,
    stdin_inline_max_bytes: 65_536,
    require_confirm_mutations: true,
    allow_outside_cwd: false,
    quiet: true,
    debug: false,
    session_logs: false,
    ai_gateway_api_key: 'test-key',
    agent_name: 'triage',
    agent: {
      type: 'decision',
      provider: 'gateway',
      model: 'typesafe-ai/jev',
      raw_bash_output: false,
      questions: QUESTIONS,
      ...overrides,
    },
    cwd: process.cwd(),
    always_execute: false,
    dry_run: false,
  };
}

describe('resolveDecisionRequest', () => {
  it('judges argument text against the agent questions', async () => {
    const request = await resolveDecisionRequest({ instruction: 'export failed', stdin: NO_STDIN, questions: QUESTIONS });
    expect(request).toEqual({ state: 'export failed', questions: QUESTIONS, questionFiles: [] });
  });

  it('sends a JSON object as JSON state', async () => {
    const request = await resolveDecisionRequest({
      instruction: '{"order": 7, "status": "late"}',
      stdin: NO_STDIN,
      questions: QUESTIONS,
    });
    expect(request.state).toEqual({ order: 7, status: 'late' });
  });

  it('reads a whole request from stdin', async () => {
    const stdin = textStdin(JSON.stringify({ state: 'hi', questions: { urgent: URGENT } }));
    const request = await resolveDecisionRequest({ instruction: '', stdin });
    expect(request).toEqual({ state: 'hi', questions: { urgent: URGENT }, questionFiles: [] });
  });

  it('takes questions from the argument and state from stdin', async () => {
    const request = await resolveDecisionRequest({
      instruction: JSON.stringify({ questions: { urgent: URGENT } }),
      stdin: textStdin('server down'),
    });
    expect(request).toEqual({ state: 'server down', questions: { urgent: URGENT }, questionFiles: [] });
  });

  it('combines argument text with an image on stdin', async () => {
    const request = await resolveDecisionRequest({
      instruction: 'checkout page',
      stdin: await binaryStdin(PNG),
      questions: QUESTIONS,
    });
    expect(request.state).toEqual([
      { type: 'text', text: 'checkout page' },
      { type: 'file', mediaType: 'image/png', data: PNG },
    ]);
  });

  it('keeps state parts and wraps other arrays as JSON', async () => {
    const parts = [{ type: 'text', text: 'a' }, { type: 'json', value: { b: 1 } }] as const;
    const asParts = await resolveDecisionRequest({ instruction: JSON.stringify(parts), stdin: NO_STDIN, questions: QUESTIONS });
    expect(asParts.state).toEqual(parts);
    const asJson = await resolveDecisionRequest({ instruction: '[1, 2]', stdin: NO_STDIN, questions: QUESTIONS });
    expect(asJson.state).toEqual([{ type: 'json', value: [1, 2] }]);
  });

  it('explains what is missing', async () => {
    await expect(resolveDecisionRequest({ instruction: 'hi', stdin: NO_STDIN })).rejects.toThrow('has no questions');
    await expect(resolveDecisionRequest({ instruction: '', stdin: NO_STDIN, questions: QUESTIONS })).rejects.toThrow(
      'Missing input',
    );
    await expect(resolveDecisionRequest({
      instruction: JSON.stringify({ state: 'hi', questions: { tone: { type: 'choice', criteria: { calm: null } } } }),
      stdin: NO_STDIN,
    })).rejects.toThrow('questions.tone.instructions: required');
    await expect(resolveDecisionRequest({
      instruction: 'hi',
      stdin: await binaryStdin(new Uint8Array([1, 2, 3, 4])),
      questions: QUESTIONS,
    })).rejects.toThrow('PNG, JPEG, GIF or WebP');
  });
});

describe('question files', () => {
  const KIND = {
    kind: {
      type: 'choice',
      instructions: 'What kind of asset this is',
      criteria: { stock: 'One company', etf: 'A fund', index: 'An index', crypto: 'A token' },
    },
  } as const;

  async function questionDirs(): Promise<{ cwd: string; homeDir: string }> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cook-questions-test-'));
    const cwd = path.join(root, 'project');
    const homeDir = path.join(root, 'home');
    await Bun.write(path.join(homeDir, '.cook', 'questions', 'asset-kind.json'), JSON.stringify(KIND));
    await Bun.write(path.join(homeDir, '.cook', 'questions', 'urgent.json'), JSON.stringify({ urgent: URGENT }));
    return { cwd, homeDir };
  }

  it('splits leading @names off the input', () => {
    expect(splitQuestionRefs('@asset-kind SPY')).toEqual({ names: ['asset-kind'], rest: 'SPY' });
    expect(splitQuestionRefs('@a @b.json  is it up?')).toEqual({ names: ['a', 'b'], rest: 'is it up?' });
    expect(splitQuestionRefs('email me@example.com')).toEqual({ names: [], rest: 'email me@example.com' });
    expect(splitQuestionRefs('@kind')).toEqual({ names: ['kind'], rest: '' });
  });

  it('judges the rest of the input against the named file', async () => {
    const dirs = await questionDirs();
    const request = await resolveDecisionRequest({ instruction: '@asset-kind SPY', stdin: NO_STDIN, questions: QUESTIONS, ...dirs });
    expect(request.state).toBe('SPY');
    expect(request.questions).toEqual(KIND);
    expect(request.questionFiles).toEqual([path.join(dirs.homeDir, '.cook', 'questions', 'asset-kind.json')]);
  });

  it('prefers the project folder, combines files, and reads state from stdin', async () => {
    const dirs = await questionDirs();
    await Bun.write(path.join(dirs.cwd, '.cook', 'questions', 'urgent.json'), JSON.stringify({ hot: URGENT }));
    const request = await resolveDecisionRequest({ instruction: '@asset-kind @urgent', stdin: textStdin('BTC'), ...dirs });
    expect(request.state).toBe('BTC');
    expect(Object.keys(request.questions)).toEqual(['kind', 'hot']);
  });

  it('explains missing, invalid, and clashing files', async () => {
    const dirs = await questionDirs();
    const resolve = (instruction: string) => resolveDecisionRequest({ instruction, stdin: NO_STDIN, ...dirs });
    await expect(resolve('@kinds SPY')).rejects.toThrow('Available: @asset-kind, @urgent.');
    await Bun.write(path.join(dirs.cwd, '.cook', 'questions', 'bad.json'), '{"x": {"type": "boolean"}}');
    await expect(resolve('@bad SPY')).rejects.toThrow('bad.json: x.instructions: required');
    await Bun.write(path.join(dirs.cwd, '.cook', 'questions', 'broken.json'), '{');
    await expect(resolve('@broken SPY')).rejects.toThrow('broken.json is not valid JSON');
    await expect(resolve('@urgent @urgent SPY')).rejects.toThrow('Question "urgent" is defined in more than one');
  });
});

describe('decision output', () => {
  it('prints the choice, score and probability per question', () => {
    const output = formatDecisionAnswers(QUESTIONS, {
      team: { type: 'choice', choice: 'technical', probabilities: { billing: 0.09, technical: 0.91 } },
      severity: { type: 'score', score: 1.424 },
      urgent: { type: 'boolean', probability: 0.873 },
    });
    expect(output).toBe(['team: technical (0.91)', 'severity: 1.42/2', 'urgent: 0.87'].join('\n'));
  });

  it('recognizes image types by their signature', () => {
    expect(detectImageType(PNG)).toBe('image/png');
    expect(detectImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(detectImageType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(detectImageType(new TextEncoder().encode('hello'))).toBeUndefined();
  });

  it('names the fields the gateway rejected', () => {
    const rejected = new Error('Invalid input', {
      cause: {
        responseBody: JSON.stringify({
          error: { message: 'Invalid input', param: [{ path: ['questions', 'tone', 'instructions'] }] },
        }),
      },
    });
    expect(describeDecisionError(rejected)).toBe('Invalid input at questions.tone.instructions');
    expect(describeDecisionError(new Error('{"error_type":"api_usage_error","message":"Invalid image dimensions."}')))
      .toBe('Invalid image dimensions.');
    expect(describeDecisionError(new Error('plain'))).toBeUndefined();
  });
});

describe('runDecision', () => {
  const answers = {
    team: { type: 'choice', choice: 'technical', probabilities: { billing: 0.1, technical: 0.9 } },
    severity: { type: 'score', score: 2 },
    urgent: { type: 'boolean', probability: 0.5 },
  };

  function mockGateway(requests: Array<{ url: string; headers: Record<string, string>; body: unknown }>): typeof fetch {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body)),
      });
      return Response.json({ model: 'typesafe-ai/jev-1.14.0', answers, usage: { inputTokens: 40, outputTokens: 0 } });
    }) as typeof fetch;
  }

  it('makes one decision-model request and prints the scores', async () => {
    const requests: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const output = await runDecision({
      instruction: 'export failed',
      runtime: decisionRuntime(),
      stdin: NO_STDIN,
      json: false,
      logDebug: () => undefined,
      fetch: mockGateway(requests),
    });

    expect(output).toBe(['team: technical (0.90)', 'severity: 2.00/2', 'urgent: 0.50'].join('\n'));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toEndWith('/decision-model');
    expect(requests[0]?.headers['ai-model-id']).toBe('typesafe-ai/jev');
    expect(requests[0]?.headers.authorization).toBe('Bearer test-key');
    expect(requests[0]?.body).toMatchObject({
      stateParts: [{ type: 'text', text: 'export failed' }],
      questions: QUESTIONS,
    });
  });

  it('prints the model, answers and usage with --json', async () => {
    const output = await runDecision({
      instruction: 'export failed',
      runtime: decisionRuntime(),
      stdin: NO_STDIN,
      json: true,
      logDebug: () => undefined,
      fetch: mockGateway([]),
    });

    expect(JSON.parse(output)).toEqual({
      model: 'typesafe-ai/jev-1.14.0',
      answers,
      usage: { inputTokens: 40, outputTokens: 0, totalTokens: 40 },
    });
  });

  it('asks for a gateway key before sending anything', async () => {
    const saved = { key: process.env.AI_GATEWAY_API_KEY, oidc: process.env.VERCEL_OIDC_TOKEN };
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_OIDC_TOKEN;
    const requests: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    try {
      const runtime = { ...decisionRuntime(), ai_gateway_api_key: undefined };
      await expect(runDecision({
        instruction: 'hi',
        runtime,
        stdin: NO_STDIN,
        json: false,
        logDebug: () => undefined,
        fetch: mockGateway(requests),
      })).rejects.toThrow('AI_GATEWAY_API_KEY');
      expect(requests).toHaveLength(0);
    } finally {
      if (saved.key !== undefined) process.env.AI_GATEWAY_API_KEY = saved.key;
      if (saved.oidc !== undefined) process.env.VERCEL_OIDC_TOKEN = saved.oidc;
    }
  });
});
