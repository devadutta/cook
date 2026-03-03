import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildSystemPrompt } from '../src/system-prompt.ts';

describe('buildSystemPrompt', () => {
  it('prefers .cook/prompts/SYSTEM.md over legacy .cook/SYSTEM.md', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cook-system-prompt-test-'));
    const cwd = path.join(tempRoot, 'workspace');
    const globalPath = path.join(cwd, '.cook', 'SYSTEM.md');
    const localPath = path.join(cwd, '.cook', 'prompts', 'SYSTEM.md');

    await mkdir(path.dirname(globalPath), { recursive: true });
    await mkdir(path.dirname(localPath), { recursive: true });

    await Bun.write(globalPath, 'global-system');
    await Bun.write(localPath, 'local-system');

    const prompt = await buildSystemPrompt({
      cwd,
      global_system_path: globalPath,
      local_system_path: localPath,
    });

    expect(prompt).toContain('local-system');
    expect(prompt).not.toContain('global-system');
  });

  it('uses configured system and appends context files in fixed order', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cook-system-prompt-test-'));
    const cwd = path.join(tempRoot, 'workspace');

    await mkdir(cwd, { recursive: true });
    await Bun.write(path.join(cwd, 'custom.md'), 'custom-system');
    await Bun.write(path.join(cwd, 'append-a.md'), 'append-a');
    await Bun.write(path.join(cwd, 'append-b.md'), 'append-b');
    await Bun.write(path.join(cwd, 'AGENTS.md'), 'agents-context');
    await Bun.write(path.join(cwd, 'claude.md'), 'claude-context');
    await Bun.write(path.join(cwd, 'cook.md'), 'cook-context');

    const prompt = await buildSystemPrompt({
      cwd,
      global_system_path: path.join(tempRoot, 'missing-global.md'),
      local_system_path: path.join(tempRoot, 'missing-local.md'),
      prompt_files: {
        system: 'custom.md',
        system_append: ['append-a.md', 'append-b.md'],
      },
      ignore_agents_md: false,
    });

    const customIndex = prompt.indexOf('custom-system');
    const appendAIndex = prompt.indexOf('append-a');
    const appendBIndex = prompt.indexOf('append-b');
    const agentsIndex = prompt.indexOf('agents-context');
    const claudeIndex = prompt.indexOf('claude-context');
    const cookIndex = prompt.indexOf('cook-context');

    expect(customIndex).toBeGreaterThan(-1);
    expect(appendAIndex).toBeGreaterThan(customIndex);
    expect(appendBIndex).toBeGreaterThan(appendAIndex);
    expect(agentsIndex).toBeGreaterThan(appendBIndex);
    expect(claudeIndex).toBeGreaterThan(agentsIndex);
    expect(cookIndex).toBeGreaterThan(claudeIndex);
  });

  it('ignore_agents_md skips AGENTS.md and CLAUDE.md but keeps cook.md', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cook-system-prompt-test-'));
    const cwd = path.join(tempRoot, 'workspace');

    await mkdir(cwd, { recursive: true });
    await Bun.write(path.join(cwd, 'AGENTS.md'), 'agents-context');
    await Bun.write(path.join(cwd, 'CLAUDE.md'), 'claude-context');
    await Bun.write(path.join(cwd, 'cook.md'), 'cook-context');

    const prompt = await buildSystemPrompt({
      cwd,
      global_system_path: path.join(tempRoot, 'missing-global.md'),
      local_system_path: path.join(tempRoot, 'missing-local.md'),
      ignore_agents_md: true,
    });

    expect(prompt).not.toContain('agents-context');
    expect(prompt).not.toContain('claude-context');
    expect(prompt).toContain('cook-context');
  });

  it('throws when configured prompt files are missing', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cook-system-prompt-test-'));
    const cwd = path.join(tempRoot, 'workspace');
    await mkdir(cwd, { recursive: true });

    await expect(
      buildSystemPrompt({
        cwd,
        global_system_path: path.join(tempRoot, 'missing-global.md'),
        local_system_path: path.join(tempRoot, 'missing-local.md'),
        prompt_files: {
          system: 'does-not-exist.md',
        },
      }),
    ).rejects.toThrow('Prompt file not found');
  });
});
