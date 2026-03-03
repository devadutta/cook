import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';

describe('loadConfig', () => {
  it('merges global, local, and CLI overrides in correct precedence', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cook-config-test-'));
    const cwd = path.join(tempRoot, 'workspace');
    const home = path.join(tempRoot, 'home');

    await mkdir(path.join(home, '.cook'), { recursive: true });
    await mkdir(path.join(cwd, '.cook'), { recursive: true });

    await Bun.write(path.join(home, '.cook', 'config.json'), JSON.stringify({
      max_steps: 9,
      quiet: true,
      debug: false,
      session_logs: true,
      verbose: false,
      ai_gateway_api_key: 'gateway-global-key',
      provider_api_keys: {
        OPENAI_API_KEY: 'openai-global-key',
      },
      default_agent: 'fast',
      agents: {
        fast: {
          provider: 'gateway',
          model: 'openai/gpt-4.1',
          raw_bash_output: true,
          prompt_files: {
            system_append: ['GLOBAL_APPEND.md'],
          },
          ignore_agents_md: false,
        },
      },
    }));

    await Bun.write(path.join(cwd, '.cook', 'config.json'), JSON.stringify({
      max_steps: 7,
      verbose: true,
      quiet: false,
      session_logs: false,
      ai_gateway_api_key: 'gateway-local-key',
      provider_api_keys: {
        ANTHROPIC_API_KEY: 'anthropic-local-key',
      },
      agents: {
        fast: {
          provider: 'openai',
          model: 'gpt-4.1-mini',
          raw_bash_output: false,
          structured_output: false,
        },
      },
    }));

    const loaded = await loadConfig(
      { cwd, homeDir: home },
      {
        max_steps: 5,
        debug: false,
      },
    );

    expect(loaded.config.max_steps).toBe(5);
    expect(loaded.config.quiet).toBe(false);
    expect(loaded.config.debug).toBe(false);
    expect(loaded.config.session_logs).toBe(false);
    expect(loaded.config.ai_gateway_api_key).toBe('gateway-local-key');
    expect(loaded.config.provider_api_keys).toEqual({
      OPENAI_API_KEY: 'openai-global-key',
      ANTHROPIC_API_KEY: 'anthropic-local-key',
    });
    expect(loaded.config.default_agent).toBe('fast');
    expect(loaded.config.agents.fast).toEqual({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      raw_bash_output: false,
      structured_output: false,
    });
  });

  it('uses legacy verbose to enable debug when debug is unset', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cook-config-test-'));
    const cwd = path.join(tempRoot, 'workspace');
    const home = path.join(tempRoot, 'home');
    await mkdir(path.join(cwd, '.cook'), { recursive: true });
    await mkdir(path.join(home, '.cook'), { recursive: true });

    await Bun.write(path.join(cwd, '.cook', 'config.json'), JSON.stringify({
      verbose: true,
    }));

    const loaded = await loadConfig({ cwd, homeDir: home }, {});
    expect(loaded.config.debug).toBe(true);
    expect(loaded.config.session_logs).toBe(false);
  });

  it('prefers explicit debug over legacy verbose across precedence layers', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cook-config-test-'));
    const cwd = path.join(tempRoot, 'workspace');
    const home = path.join(tempRoot, 'home');

    await mkdir(path.join(home, '.cook'), { recursive: true });
    await mkdir(path.join(cwd, '.cook'), { recursive: true });

    await Bun.write(path.join(home, '.cook', 'config.json'), JSON.stringify({
      debug: true,
    }));
    await Bun.write(path.join(cwd, '.cook', 'config.json'), JSON.stringify({
      verbose: false,
    }));

    const loaded = await loadConfig({ cwd, homeDir: home }, {});
    expect(loaded.config.debug).toBe(true);
  });
});
