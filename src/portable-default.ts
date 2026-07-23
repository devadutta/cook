import { DEFAULT_CONFIG } from './defaults.ts';
import type { AgentConfig, AgentProvider, CookConfig } from './types.ts';

export interface PortableDefaultCandidate {
  provider: AgentProvider;
  model: string;
  credential_env?: string;
  source: 'gateway' | 'provider_api_keys' | 'openai_oauth';
}

export const PORTABLE_DEFAULT_PRECEDENCE: PortableDefaultCandidate[] = [
  {
    provider: 'gateway',
    model: 'google/gemini-3-flash-preview',
    credential_env: 'AI_GATEWAY_API_KEY',
    source: 'gateway',
  },
  {
    provider: 'openai',
    model: 'gpt-5.2',
    credential_env: 'OPENAI_API_KEY',
    source: 'provider_api_keys',
  },
  {
    provider: 'openai-codex',
    model: 'gpt-5.6-sol',
    source: 'openai_oauth',
  },
  {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    credential_env: 'ANTHROPIC_API_KEY',
    source: 'provider_api_keys',
  },
  {
    provider: 'google',
    model: 'gemini-3-flash-preview',
    credential_env: 'GOOGLE_GENERATIVE_AI_API_KEY',
    source: 'provider_api_keys',
  },
  {
    provider: 'groq',
    model: 'moonshotai/kimi-k2-instruct-0905',
    credential_env: 'GROQ_API_KEY',
    source: 'provider_api_keys',
  },
];

function hasValue(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function sameStringArray(left: string[] | undefined, right: string[] | undefined): boolean {
  const leftValue = left ?? [];
  const rightValue = right ?? [];
  if (leftValue.length !== rightValue.length) {
    return false;
  }

  for (let index = 0; index < leftValue.length; index += 1) {
    if (leftValue[index] !== rightValue[index]) {
      return false;
    }
  }

  return true;
}

export function isBuiltInDefaultAgent(agentName: string, agent: AgentConfig): boolean {
  if (agentName !== 'default') {
    return false;
  }

  const builtIn = DEFAULT_CONFIG.agents.default;
  if (!builtIn) {
    return false;
  }
  if (agent.provider !== builtIn.provider) {
    return false;
  }
  if (agent.model !== builtIn.model) {
    return false;
  }
  if (agent.structured_output !== undefined) {
    return false;
  }
  if (Boolean(agent.ignore_agents_md) !== Boolean(builtIn.ignore_agents_md)) {
    return false;
  }
  if (Boolean(agent.raw_bash_output) !== Boolean(builtIn.raw_bash_output)) {
    return false;
  }
  if ((agent.prompt_files?.system ?? undefined) !== (builtIn.prompt_files?.system ?? undefined)) {
    return false;
  }

  return sameStringArray(
    agent.prompt_files?.system_append,
    builtIn.prompt_files?.system_append,
  );
}

export function resolvePortableDefaultProvider(
  config: CookConfig,
  env: Record<string, string | undefined> = process.env,
  availability: { openaiOAuth?: boolean } = {},
): PortableDefaultCandidate | null {
  for (const candidate of PORTABLE_DEFAULT_PRECEDENCE) {
    if (candidate.source === 'openai_oauth') {
      if (availability.openaiOAuth) {
        return candidate;
      }
      continue;
    }

    const credentialEnv = candidate.credential_env;
    if (!credentialEnv) {
      continue;
    }

    if (candidate.source === 'gateway') {
      if (hasValue(config.ai_gateway_api_key) || hasValue(env[credentialEnv])) {
        return candidate;
      }
      continue;
    }

    if (
      hasValue(config.provider_api_keys?.[credentialEnv]) ||
      hasValue(env[credentialEnv])
    ) {
      return candidate;
    }
  }

  return null;
}
