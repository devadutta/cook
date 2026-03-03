import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initConfigFiles } from '../src/config-init.ts';

describe('initConfigFiles', () => {
  it('writes local config by default path when requested', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cook-init-test-'));
    const cwd = path.join(tempRoot, 'workspace');
    await mkdir(cwd, { recursive: true });

    const result = await initConfigFiles({
      cwd,
      writeLocal: true,
      writeGlobal: false,
      force: false,
    });

    expect(result.written.length).toBe(1);
    expect(result.skipped.length).toBe(0);

    const content = await Bun.file(path.join(cwd, '.cook', 'config.json')).text();
    const parsed = JSON.parse(content) as Record<string, unknown>;

    expect(parsed.quiet).toBe(false);
    expect(parsed.debug).toBe(false);
    expect(parsed.session_logs).toBe(false);
    expect(parsed.agents).toMatchObject({
      default: {
        raw_bash_output: false,
      },
    });
    expect(parsed.verbose).toBeUndefined();
    expect(parsed.ai_gateway_api_key).toBe('YOUR_AI_GATEWAY_API_KEY');
    expect(parsed.provider_api_keys).toEqual({
      OPENAI_API_KEY: 'YOUR_OPENAI_API_KEY',
      ANTHROPIC_API_KEY: 'YOUR_ANTHROPIC_API_KEY',
      GOOGLE_GENERATIVE_AI_API_KEY: 'YOUR_GOOGLE_GENERATIVE_AI_API_KEY',
      GROQ_API_KEY: 'YOUR_GROQ_API_KEY',
    });
  });

  it('does not overwrite existing config without force', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cook-init-test-'));
    const cwd = path.join(tempRoot, 'workspace');
    await mkdir(path.join(cwd, '.cook'), { recursive: true });

    const configPath = path.join(cwd, '.cook', 'config.json');
    await Bun.write(configPath, JSON.stringify({ max_steps: 3 }, null, 2));

    const result = await initConfigFiles({
      cwd,
      writeLocal: true,
      writeGlobal: false,
      force: false,
    });

    expect(result.written.length).toBe(0);
    expect(result.skipped.length).toBe(1);

    const content = await Bun.file(configPath).text();
    expect(content).toContain('"max_steps": 3');
  });

  it('writes both global and local when requested', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cook-init-test-'));
    const cwd = path.join(tempRoot, 'workspace');
    const homeDir = path.join(tempRoot, 'home');
    await mkdir(cwd, { recursive: true });

    const result = await initConfigFiles({
      cwd,
      homeDir,
      writeLocal: true,
      writeGlobal: true,
      force: false,
    });

    expect(result.written.length).toBe(2);
    expect(await Bun.file(path.join(cwd, '.cook', 'config.json')).exists()).toBe(true);
    expect(await Bun.file(path.join(homeDir, '.cook', 'config.json')).exists()).toBe(true);
  });
});
