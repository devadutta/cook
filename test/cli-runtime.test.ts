import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createRuntimeConfig } from '../src/cli.ts';
import { DEFAULT_CONFIG } from '../src/defaults.ts';
import type { CookConfig } from '../src/types.ts';

const PROVIDER_ENV_KEYS = [
  'AI_GATEWAY_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GROQ_API_KEY',
] as const;

type ProviderEnvKey = typeof PROVIDER_ENV_KEYS[number];

let envSnapshot: Record<ProviderEnvKey, string | undefined>;

function clearProviderEnv(): void {
  for (const key of PROVIDER_ENV_KEYS) {
    delete process.env[key];
  }
}

function buildConfig(rawBashOutput = false): CookConfig {
  const config: CookConfig = structuredClone(DEFAULT_CONFIG);
  config.default_agent = 'default';
  const defaultAgent = config.agents.default;
  if (!defaultAgent) {
    throw new Error('DEFAULT_CONFIG is missing agents.default in test setup');
  }
  defaultAgent.raw_bash_output = rawBashOutput;
  return config;
}

describe('createRuntimeConfig', () => {
  beforeEach(() => {
    envSnapshot = {
      AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
      GROQ_API_KEY: process.env.GROQ_API_KEY,
    };
    clearProviderEnv();
  });

  afterEach(() => {
    clearProviderEnv();
    for (const key of PROVIDER_ENV_KEYS) {
      const value = envSnapshot[key];
      if (value !== undefined) {
        process.env[key] = value;
      }
    }
  });

  it('uses built-in gateway default model when no keys are present', () => {
    const runtime = createRuntimeConfig(buildConfig(false), {});
    expect(runtime.agent.provider).toBe('gateway');
    expect(runtime.agent.model).toBe('google/gemini-3-flash-preview');
  });

  it('selects openai when only OPENAI_API_KEY is set', () => {
    process.env.OPENAI_API_KEY = 'openai-key';
    const runtime = createRuntimeConfig(buildConfig(false), {});
    expect(runtime.agent.provider).toBe('openai');
    expect(runtime.agent.model).toBe('gpt-5.2');
  });

  it('uses precedence when OPENAI_API_KEY and GROQ_API_KEY are both set', () => {
    process.env.OPENAI_API_KEY = 'openai-key';
    process.env.GROQ_API_KEY = 'groq-key';
    const runtime = createRuntimeConfig(buildConfig(false), {});
    expect(runtime.agent.provider).toBe('openai');
    expect(runtime.agent.model).toBe('gpt-5.2');
  });

  it('uses precedence when AI_GATEWAY_API_KEY and OPENAI_API_KEY are both set', () => {
    process.env.AI_GATEWAY_API_KEY = 'gateway-key';
    process.env.OPENAI_API_KEY = 'openai-key';
    const runtime = createRuntimeConfig(buildConfig(false), {});
    expect(runtime.agent.provider).toBe('gateway');
    expect(runtime.agent.model).toBe('google/gemini-3-flash-preview');
  });

  it('selects anthropic when only ANTHROPIC_API_KEY is set', () => {
    process.env.ANTHROPIC_API_KEY = 'anthropic-key';
    const runtime = createRuntimeConfig(buildConfig(false), {});
    expect(runtime.agent.provider).toBe('anthropic');
    expect(runtime.agent.model).toBe('claude-sonnet-4-6');
  });

  it('selects google when only GOOGLE_GENERATIVE_AI_API_KEY is set', () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'google-key';
    const runtime = createRuntimeConfig(buildConfig(false), {});
    expect(runtime.agent.provider).toBe('google');
    expect(runtime.agent.model).toBe('gemini-3-flash-preview');
  });

  it('selects groq when only GROQ_API_KEY is set', () => {
    process.env.GROQ_API_KEY = 'groq-key';
    const runtime = createRuntimeConfig(buildConfig(false), {});
    expect(runtime.agent.provider).toBe('groq');
    expect(runtime.agent.model).toBe('moonshotai/kimi-k2-instruct-0905');
  });

  it('uses config-based provider_api_keys when env is empty', () => {
    const config = buildConfig(false);
    config.provider_api_keys = {
      OPENAI_API_KEY: 'openai-config-key',
    };
    const runtime = createRuntimeConfig(config, {});
    expect(runtime.agent.provider).toBe('openai');
    expect(runtime.agent.model).toBe('gpt-5.2');
  });

  it('does not override user-configured agents.default', () => {
    process.env.OPENAI_API_KEY = 'openai-key';
    const config = buildConfig(false);
    config.agents.default = {
      provider: 'groq',
      model: 'llama-3.3-70b-versatile',
      raw_bash_output: false,
    };
    const runtime = createRuntimeConfig(config, {});
    expect(runtime.agent.provider).toBe('groq');
    expect(runtime.agent.model).toBe('llama-3.3-70b-versatile');
  });

  it('keeps raw_bash_output disabled by default', () => {
    const runtime = createRuntimeConfig(buildConfig(false), {});
    expect(runtime.agent.raw_bash_output).toBe(false);
  });

  it('enables raw_bash_output when --raw is passed', () => {
    const runtime = createRuntimeConfig(buildConfig(false), { raw: true });
    expect(runtime.agent.raw_bash_output).toBe(true);
  });

  it('keeps configured raw_bash_output enabled without --raw', () => {
    const runtime = createRuntimeConfig(buildConfig(true), {});
    expect(runtime.agent.raw_bash_output).toBe(true);
  });

  it('applies --raw with an auto-selected provider', () => {
    process.env.OPENAI_API_KEY = 'openai-key';
    const runtime = createRuntimeConfig(buildConfig(false), { raw: true });
    expect(runtime.agent.provider).toBe('openai');
    expect(runtime.agent.model).toBe('gpt-5.2');
    expect(runtime.agent.raw_bash_output).toBe(true);
  });
});
