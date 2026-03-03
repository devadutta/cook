import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { DEFAULT_CONFIG } from './defaults.ts';
import type { AgentConfig, CookConfig, LoadedConfig } from './types.ts';

const provider_api_keys_schema = z.record(
  z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  z.string().min(1),
);

const provider_schema = z.enum(['gateway', 'google', 'anthropic', 'openai', 'groq']);

const prompt_files_schema = z.object({
  system: z.string().min(1).optional(),
  system_append: z.array(z.string().min(1)).optional(),
}).strict();

const agent_schema = z.object({
  provider: provider_schema,
  model: z.string().min(1),
  structured_output: z.boolean().optional(),
  prompt_files: prompt_files_schema.optional(),
  ignore_agents_md: z.boolean().optional(),
  raw_bash_output: z.boolean().optional(),
}).strict();

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
type ConfigFile = z.infer<typeof config_file_schema>;
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

async function readConfigFile(filePath: string): Promise<ConfigFile> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return {};
  }

  const text = await file.text();
  if (!text.trim()) {
    return {};
  }

  const parsed = JSON.parse(text) as unknown;
  const result = config_file_schema.safeParse(parsed);

  if (!result.success) {
    const issues = result.error.issues
      .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join(', ');
    throw new Error(`Invalid config at ${filePath}: ${issues}`);
  }

  return result.data;
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
