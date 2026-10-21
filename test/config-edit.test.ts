import { describe, expect, it } from 'bun:test';
import { mkdtemp, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readConfigFile, updateConfigFile } from '../src/config.ts';
import {
  getConfiguredApiKey,
  maskSecret,
  withAgentModel,
  withAgentOption,
  withApiKey,
  withDefaultAgent,
  withOption,
  withoutAgent,
} from '../src/config-edit.ts';
import { DEFAULT_CONFIG } from '../src/defaults.ts';
import type { AgentConfig } from '../src/types.ts';

const builtInDefault = DEFAULT_CONFIG.agents.default as AgentConfig;

describe('config edits', () => {
  it('pins a model without copying built-in default noise', () => {
    const next = withAgentModel({}, 'default', builtInDefault, 'anthropic', 'claude-sonnet-4-6');
    expect(next).toEqual({
      agents: { default: { provider: 'anthropic', model: 'claude-sonnet-4-6' } },
    });
  });

  it('keeps the other fields of an agent already in the file', () => {
    const file = {
      agents: {
        work: {
          provider: 'groq' as const,
          model: 'old',
          raw_bash_output: true,
          prompt_files: { system: 'SYSTEM.md' },
        },
      },
    };
    const next = withAgentModel(file, 'work', builtInDefault, 'openai', 'gpt-5.2');
    expect(next.agents?.work).toEqual({
      provider: 'openai',
      model: 'gpt-5.2',
      raw_bash_output: true,
      prompt_files: { system: 'SYSTEM.md' },
    });
  });

  it('copies the effective agent when the file does not define it yet', () => {
    const effective: AgentConfig = {
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
      ignore_agents_md: true,
      prompt_files: { system_append: [] },
    };
    const next = withAgentOption({}, 'default', effective, 'raw_bash_output', true);
    expect(next.agents?.default).toEqual({
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
      ignore_agents_md: true,
      raw_bash_output: true,
    });
  });

  it('drops empty prompt files', () => {
    const file = {
      agents: { default: { provider: 'gateway' as const, model: 'x', prompt_files: { system: 'a.md' } } },
    };
    const next = withAgentOption(file, 'default', builtInDefault, 'prompt_files', {
      system: undefined,
      system_append: [],
    });
    expect(next.agents?.default).toEqual({ provider: 'gateway', model: 'x' });
  });

  it('removes an agent and the agents map once it is empty', () => {
    const file = { max_steps: 5, agents: { default: { provider: 'groq' as const, model: 'x' } } };
    expect(withoutAgent(file, 'default')).toEqual({ max_steps: 5 });
    expect(withoutAgent({ max_steps: 5 }, 'default')).toEqual({ max_steps: 5 });
  });

  it('stores a copy of the default agent next to default_agent', () => {
    const effective: AgentConfig = { provider: 'groq', model: 'kimi' };
    expect(withDefaultAgent({}, 'fast', effective)).toEqual({
      default_agent: 'fast',
      agents: { fast: { provider: 'groq', model: 'kimi' } },
    });
    const existing = { agents: { fast: { provider: 'openai' as const, model: 'gpt' } } };
    expect(withDefaultAgent(existing, 'fast', effective).agents?.fast).toEqual({
      provider: 'openai',
      model: 'gpt',
    });
    expect(withDefaultAgent({}, 'default', undefined)).toEqual({ default_agent: 'default' });
  });

  it('sets and resets options', () => {
    expect(withOption({}, 'max_steps', 20)).toEqual({ max_steps: 20 });
    expect(withOption({ max_steps: 20, quiet: true }, 'max_steps', undefined)).toEqual({ quiet: true });
  });

  it('stores the gateway key separately from provider keys', () => {
    const withGateway = withApiKey({}, 'AI_GATEWAY_API_KEY', 'gw');
    expect(withGateway).toEqual({ ai_gateway_api_key: 'gw' });
    const withOpenAI = withApiKey(withGateway, 'OPENAI_API_KEY', 'sk');
    expect(withOpenAI).toEqual({ ai_gateway_api_key: 'gw', provider_api_keys: { OPENAI_API_KEY: 'sk' } });
    expect(getConfiguredApiKey(withOpenAI, 'AI_GATEWAY_API_KEY')).toBe('gw');
    expect(getConfiguredApiKey(withOpenAI, 'OPENAI_API_KEY')).toBe('sk');

    const removed = withApiKey(withApiKey(withOpenAI, 'OPENAI_API_KEY', undefined), 'AI_GATEWAY_API_KEY', undefined);
    expect(removed).toEqual({});
  });

  it('masks secrets', () => {
    expect(maskSecret('sk-test-1234567890abcdef')).toBe('sk-…cdef');
    expect(maskSecret('short')).toBe('••••');
  });
});

describe('updateConfigFile', () => {
  it('creates the file with owner-only permissions', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cook-config-edit-'));
    const filePath = path.join(dir, '.cook', 'config.json');

    await updateConfigFile(filePath, file => withApiKey(file, 'OPENAI_API_KEY', 'sk-test'));

    expect(await readConfigFile(filePath)).toEqual({ provider_api_keys: { OPENAI_API_KEY: 'sk-test' } });
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it('rejects invalid edits and leaves the file untouched', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cook-config-edit-'));
    const filePath = path.join(dir, 'config.json');
    await Bun.write(filePath, '{\n  "max_steps": 10\n}\n');

    await expect(updateConfigFile(filePath, file => withOption(file, 'max_steps', 500))).rejects.toThrow(
      'max_steps',
    );
    expect(await Bun.file(filePath).text()).toBe('{\n  "max_steps": 10\n}\n');
  });
});
