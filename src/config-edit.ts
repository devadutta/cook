import type { ConfigFile } from './config.ts';
import type { AgentConfig, AgentProvider, CookConfig } from './types.ts';

export type EditableOption =
  | 'max_steps'
  | 'bash_timeout_ms'
  | 'bash_output_limit_bytes'
  | 'stdin_inline_max_bytes'
  | 'require_confirm_mutations'
  | 'allow_outside_cwd'
  | 'quiet'
  | 'debug'
  | 'session_logs';

export type EditableAgentOption =
  | 'raw_bash_output'
  | 'ignore_agents_md'
  | 'prompt_files'
  | 'thinking'
  | 'fast';

export const GATEWAY_KEY_ENV = 'AI_GATEWAY_API_KEY';

// Drops values that only restate built-in defaults so copied agents stay small.
function compactAgent(agent: AgentConfig): AgentConfig {
  const compacted: AgentConfig = agent.type === 'decision'
    ? { type: 'decision', provider: agent.provider, model: agent.model }
    : { provider: agent.provider, model: agent.model };
  if (agent.questions) {
    compacted.questions = agent.questions;
  }
  if (agent.structured_output !== undefined) {
    compacted.structured_output = agent.structured_output;
  }
  if (agent.raw_bash_output) {
    compacted.raw_bash_output = true;
  }
  if (agent.ignore_agents_md) {
    compacted.ignore_agents_md = true;
  }
  if (agent.thinking) {
    compacted.thinking = agent.thinking;
  }
  if (agent.fast) {
    compacted.fast = true;
  }
  const promptFiles = compactPromptFiles(agent.prompt_files);
  if (promptFiles) {
    compacted.prompt_files = promptFiles;
  }
  return compacted;
}

function compactPromptFiles(
  promptFiles: AgentConfig['prompt_files'],
): AgentConfig['prompt_files'] {
  const compacted: NonNullable<AgentConfig['prompt_files']> = {};
  if (promptFiles?.system) {
    compacted.system = promptFiles.system;
  }
  if (promptFiles?.system_append && promptFiles.system_append.length > 0) {
    compacted.system_append = promptFiles.system_append;
  }
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

// Agents are replaced wholesale across config files, so an edit starts from the
// agent already in this file, or from a copy of the effective agent.
function editAgent(
  file: ConfigFile,
  agentName: string,
  effective: AgentConfig,
  edit: (agent: AgentConfig) => AgentConfig,
): ConfigFile {
  const current = file.agents?.[agentName] ?? compactAgent(effective);
  return {
    ...file,
    agents: { ...file.agents, [agentName]: edit({ ...current }) },
  };
}

export function withAgentModel(
  file: ConfigFile,
  agentName: string,
  effective: AgentConfig,
  provider: AgentProvider,
  model: string,
): ConfigFile {
  return editAgent(file, agentName, effective, agent => ({ ...agent, provider, model }));
}

export function withAgentOption<K extends EditableAgentOption>(
  file: ConfigFile,
  agentName: string,
  effective: AgentConfig,
  key: K,
  value: AgentConfig[K] | undefined,
): ConfigFile {
  return editAgent(file, agentName, effective, agent => {
    const next = { ...agent, [key]: value };
    if (key === 'prompt_files') {
      next.prompt_files = compactPromptFiles(value as AgentConfig['prompt_files']);
    }
    if (next[key] === undefined) {
      delete next[key];
    }
    return next;
  });
}

export function withNewAgent(file: ConfigFile, agentName: string, agent: AgentConfig): ConfigFile {
  return { ...file, agents: { ...file.agents, [agentName]: compactAgent(agent) } };
}

export function withoutAgent(file: ConfigFile, agentName: string): ConfigFile {
  if (!file.agents?.[agentName]) {
    return file;
  }

  const { [agentName]: _removed, ...agents } = file.agents;
  const next: ConfigFile = { ...file, agents };
  if (Object.keys(agents).length === 0) {
    delete next.agents;
  }
  return next;
}

export function withDefaultAgent(
  file: ConfigFile,
  agentName: string,
  effective: AgentConfig | undefined,
): ConfigFile {
  const next: ConfigFile = { ...file, default_agent: agentName };
  // A default_agent that only exists in another config file breaks cook wherever
  // that file is not loaded, so keep a copy of the agent next to the reference.
  if (effective && !file.agents?.[agentName]) {
    next.agents = { ...file.agents, [agentName]: compactAgent(effective) };
  }
  return next;
}

export function withOption<K extends EditableOption>(
  file: ConfigFile,
  key: K,
  value: CookConfig[K] | undefined,
): ConfigFile {
  const next = { ...file, [key]: value };
  if (value === undefined) {
    delete next[key];
  }
  return next;
}

export function getConfiguredApiKey(
  config: Pick<CookConfig, 'ai_gateway_api_key' | 'provider_api_keys'>,
  envName: string,
): string | undefined {
  return envName === GATEWAY_KEY_ENV
    ? config.ai_gateway_api_key
    : config.provider_api_keys?.[envName];
}

export function withApiKey(
  file: ConfigFile,
  envName: string,
  value: string | undefined,
): ConfigFile {
  const next = { ...file };
  if (envName === GATEWAY_KEY_ENV) {
    if (value) {
      next.ai_gateway_api_key = value;
    } else {
      delete next.ai_gateway_api_key;
    }
    return next;
  }

  const keys = { ...file.provider_api_keys };
  if (value) {
    keys[envName] = value;
  } else {
    delete keys[envName];
  }

  if (Object.keys(keys).length > 0) {
    next.provider_api_keys = keys;
  } else {
    delete next.provider_api_keys;
  }
  return next;
}

export function maskSecret(value: string): string {
  return value.length <= 8 ? '••••' : `${value.slice(0, 3)}…${value.slice(-4)}`;
}
