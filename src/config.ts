import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { DEFAULT_CONFIG } from './defaults.ts';
import { THINKING_LEVELS } from './provider-options.ts';
import type { AgentConfig, CookConfig, LoadedConfig } from './types.ts';

const provider_api_keys_schema = z.record(
  z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  z.string().min(1),
);

const provider_schema = z.enum([
  'gateway',
  'google',
  'anthropic',
  'openai',
  'openai-codex',
  'groq',
]);

const prompt_files_schema = z.object({
  system: z.string().min(1).optional(),
  system_append: z.array(z.string().min(1)).optional(),
}).strict();

// Mirrors the AI SDK decision question types. The gateway also requires
// instructions on every question, though the SDK lets providers waive them.
const decision_text_schema = z.union(
  [z.string(), z.record(z.string(), z.json()), z.array(z.json())],
  { error: issue => (issue.input === undefined ? 'required' : 'expected text, a JSON object or a JSON array') },
);

const decision_question_schema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('choice'),
    instructions: decision_text_schema,
    criteria: z.record(z.string(), decision_text_schema.nullable()).refine(
      value => Object.keys(value).length > 0,
      { message: 'choice questions need at least one option' },
    ),
  }).strict(),
  z.object({
    type: z.literal('score'),
    instructions: decision_text_schema,
    criteria: z.array(decision_text_schema.nullable()).min(1),
  }).strict(),
  z.object({
    type: z.literal('boolean'),
    instructions: decision_text_schema,
    criteria: z.object({
      true: decision_text_schema.nullable().optional(),
      false: decision_text_schema.nullable().optional(),
    }).strict().optional(),
  }).strict(),
], { error: 'type must be choice, score or boolean' });

export const decision_questions_schema = z.record(z.string().min(1), decision_question_schema).refine(
  value => Object.keys(value).length > 0,
  { message: 'at least one question is required' },
);
export type DecisionQuestions = z.infer<typeof decision_questions_schema>;

const agent_schema = z.object({
  type: z.enum(['agent', 'decision']).optional(),
  provider: provider_schema,
  model: z.string().min(1),
  structured_output: z.boolean().optional(),
  prompt_files: prompt_files_schema.optional(),
  ignore_agents_md: z.boolean().optional(),
  raw_bash_output: z.boolean().optional(),
  thinking: z.enum(THINKING_LEVELS).optional(),
  fast: z.boolean().optional(),
  questions: decision_questions_schema.optional(),
}).strict().refine(
  agent => agent.type !== 'decision' || agent.provider === 'gateway',
  { message: 'decision agents run on the gateway provider', path: ['provider'] },
).refine(
  agent => agent.type === 'decision' || agent.questions === undefined,
  { message: 'questions only apply to agents with "type": "decision"', path: ['questions'] },
);

const full_config_schema = z.object({
  max_steps: z.number().int().min(1).max(100),
  bash_timeout_ms: z.number().int().min(100).max(3_600_000),
  bash_output_limit_bytes: z.number().int().min(1_024).max(20 * 1024 * 1024),
  stdin_inline_max_bytes: z.number().int().min(1_024).max(5 * 1024 * 1024),
  require_confirm_mutations: z.boolean(),
  allow_outside_cwd: z.boolean(),
  quiet: z.boolean(),
  debug: z.boolean(),
  session_logs: z.boolean(),
  ai_gateway_api_key: z.string().min(1).optional(),
  provider_api_keys: provider_api_keys_schema.optional(),
  default_agent: z.string().min(1).optional(),
  agents: z.record(z.string().min(1), agent_schema).refine(
    value => Object.keys(value).length > 0,
    { message: 'At least one agent must be configured' },
  ),
}).strict();

const config_file_schema = z.object({
  ...full_config_schema.shape,
  verbose: z.boolean().optional(),
}).partial().strict();
export type ConfigFile = z.infer<typeof config_file_schema>;
type ConfigWithLegacyVerbose = Partial<CookConfig> & { verbose?: boolean };

interface LoadConfigOptions {
  cwd: string;
  homeDir?: string;
}

export function getConfigPaths(cwd: string, homeDir = os.homedir()): {
  global_path: string;
  local_path: string;
} {
  return {
    global_path: path.join(homeDir, '.cook', 'config.json'),
    local_path: path.join(cwd, '.cook', 'config.json'),
  };
}

export function getSystemPromptPaths(cwd: string, homeDir = os.homedir()): {
  global_system_path: string;
  local_system_path: string;
} {
  return {
    global_system_path: path.join(cwd, '.cook', 'SYSTEM.md'),
    local_system_path: path.join(cwd, '.cook', 'prompts', 'SYSTEM.md'),
  };
}

function parseConfigFile(value: unknown, filePath: string): ConfigFile {
  const result = config_file_schema.safeParse(value);

  if (!result.success) {
    const issues = result.error.issues
      .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join(', ');
    throw new Error(`Invalid config at ${filePath}: ${issues}`);
  }

  return result.data;
}

export async function readConfigFile(filePath: string): Promise<ConfigFile> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return {};
  }

  const text = await file.text();
  if (!text.trim()) {
    return {};
  }

  return parseConfigFile(JSON.parse(text) as unknown, filePath);
}

export async function updateConfigFile(
  filePath: string,
  update: (current: ConfigFile) => ConfigFile,
): Promise<ConfigFile> {
  const current = await readConfigFile(filePath);
  const next = parseConfigFile(update(structuredClone(current)), filePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  // Config files can hold API keys; mode only applies when the file is created.
  // (Bun.write ignores `mode`, so this uses node:fs.)
  await writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return next;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Partial<T>;
}

function omitLegacyVerbose<T extends { verbose?: boolean }>(value: T): Omit<T, 'verbose'> {
  const { verbose: _verbose, ...rest } = value;
  return rest;
}

function resolveDebugSetting(
  ...sources: Array<{ debug?: boolean; verbose?: boolean }>
): boolean {
  for (const source of sources) {
    if (source.debug !== undefined) {
      return source.debug;
    }
  }

  for (const source of sources) {
    if (source.verbose !== undefined) {
      return source.verbose;
    }
  }

  return DEFAULT_CONFIG.debug;
}

function mergeProviderApiKeys(
  ...sources: Array<Pick<CookConfig, 'provider_api_keys'>>
): Record<string, string> | undefined {
  const merged: Record<string, string> = {};

  for (const source of sources) {
    if (!source.provider_api_keys) {
      continue;
    }

    Object.assign(merged, source.provider_api_keys);
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeAgents(
  ...sources: Array<{ agents?: Record<string, AgentConfig> }>
): Record<string, AgentConfig> {
  const merged: Record<string, AgentConfig> = {};

  for (const source of sources) {
    if (!source.agents) {
      continue;
    }

    Object.assign(merged, source.agents);
  }

  return merged;
}

export async function loadConfig(
  options: LoadConfigOptions,
  cliOverrides: ConfigWithLegacyVerbose,
): Promise<LoadedConfig> {
  const { cwd, homeDir } = options;
  const { global_path, local_path } = getConfigPaths(cwd, homeDir);
  const { global_system_path, local_system_path } = getSystemPromptPaths(cwd, homeDir);

  const [globalConfig, localConfig] = await Promise.all([
    readConfigFile(global_path),
    readConfigFile(local_path),
  ]);
  const cleanedCliOverrides = stripUndefined(cliOverrides);
  const globalConfigWithoutVerbose = omitLegacyVerbose(globalConfig);
  const localConfigWithoutVerbose = omitLegacyVerbose(localConfig);
  const cliOverridesWithoutVerbose = omitLegacyVerbose(cleanedCliOverrides);
  const provider_api_keys = mergeProviderApiKeys(
    globalConfigWithoutVerbose,
    localConfigWithoutVerbose,
    cliOverridesWithoutVerbose,
  );
  const agents = mergeAgents(
    DEFAULT_CONFIG,
    globalConfigWithoutVerbose,
    localConfigWithoutVerbose,
    cliOverridesWithoutVerbose,
  );

  const merged = {
    ...DEFAULT_CONFIG,
    ...globalConfigWithoutVerbose,
    ...localConfigWithoutVerbose,
    ...cliOverridesWithoutVerbose,
    debug: resolveDebugSetting(
      cleanedCliOverrides,
      localConfig,
      globalConfig,
    ),
    ...(provider_api_keys ? { provider_api_keys } : {}),
    agents,
  };

  const validated = full_config_schema.parse(merged);

  return {
    config: validated,
    global_path,
    local_path,
    global_system_path,
    local_system_path,
  };
}

export async function ensureLocalConfigDir(cwd: string): Promise<string> {
  const dir = path.join(cwd, '.cook');
  await mkdir(dir, { recursive: true });
  return dir;
}
