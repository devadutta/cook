import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveCommandInstruction } from '../src/command-instruction.ts';

describe('resolveCommandInstruction', () => {
  it('returns original instruction when not an alias', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cook-command-instruction-test-'));
    const cwd = path.join(tempRoot, 'workspace');
    const homeDir = path.join(tempRoot, 'home');
    await mkdir(cwd, { recursive: true });

    const result = await resolveCommandInstruction({
      instruction: 'summarize this repo',
      cwd,
      homeDir,
    });

    expect(result.instruction).toBe('summarize this repo');
    expect(result.commandName).toBeUndefined();
    expect(result.sourcePath).toBeUndefined();
  });

  it('resolves aliases from ~/.cook/commands', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cook-command-instruction-test-'));
    const cwd = path.join(tempRoot, 'workspace');
    const homeDir = path.join(tempRoot, 'home');
    const homeCommands = path.join(homeDir, '.cook', 'commands');

    await mkdir(cwd, { recursive: true });
    await mkdir(homeCommands, { recursive: true });
    await Bun.write(path.join(homeCommands, 'create-pr.md'), 'open a PR with a clear summary');

    const result = await resolveCommandInstruction({
      instruction: '/create-pr',
      cwd,
      homeDir,
    });

    expect(result.instruction).toBe('open a PR with a clear summary');
    expect(result.sourcePath).toBe(path.join(homeCommands, 'create-pr.md'));
    expect(result.commandName).toBe('create-pr');
  });

  it('uses provider precedence cook > cursor > claude > codex', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cook-command-instruction-test-'));
    const cwd = path.join(tempRoot, 'workspace');
    const homeDir = path.join(tempRoot, 'home');

    const cookPath = path.join(cwd, '.cook', 'commands');
    const cursorPath = path.join(cwd, '.cursor', 'commands');
    const claudePath = path.join(cwd, '.claude', 'commands');
    const codexPath = path.join(cwd, '.codex', 'commands');

    await mkdir(cookPath, { recursive: true });
    await mkdir(cursorPath, { recursive: true });
    await mkdir(claudePath, { recursive: true });
    await mkdir(codexPath, { recursive: true });

    await Bun.write(path.join(cookPath, 'sync.md'), 'from-cook');
    await Bun.write(path.join(cursorPath, 'sync.md'), 'from-cursor');
    await Bun.write(path.join(claudePath, 'sync.md'), 'from-claude');
    await Bun.write(path.join(codexPath, 'sync.md'), 'from-codex');

    const result = await resolveCommandInstruction({
      instruction: '/sync',
      cwd,
      homeDir,
    });

    expect(result.instruction).toBe('from-cook');
    expect(result.sourcePath).toBe(path.join(cookPath, 'sync.md'));
  });

  it('prefers local directory over home for same provider', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cook-command-instruction-test-'));
    const cwd = path.join(tempRoot, 'workspace');
    const homeDir = path.join(tempRoot, 'home');

    const localCookPath = path.join(cwd, '.cook', 'commands');
    const homeCookPath = path.join(homeDir, '.cook', 'commands');
    await mkdir(localCookPath, { recursive: true });
    await mkdir(homeCookPath, { recursive: true });

    await Bun.write(path.join(homeCookPath, 'lint.md'), 'from-home');
    await Bun.write(path.join(localCookPath, 'lint.md'), 'from-local');

    const result = await resolveCommandInstruction({
      instruction: '/lint',
      cwd,
      homeDir,
    });

    expect(result.instruction).toBe('from-local');
    expect(result.sourcePath).toBe(path.join(localCookPath, 'lint.md'));
  });

  it('requires exact filename match', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cook-command-instruction-test-'));
    const cwd = path.join(tempRoot, 'workspace');
    const homeDir = path.join(tempRoot, 'home');
    const localCookPath = path.join(cwd, '.cook', 'commands');
    await mkdir(localCookPath, { recursive: true });

    await Bun.write(path.join(localCookPath, 'create-pr-template.md'), 'near match only');

    await expect(
      resolveCommandInstruction({
        instruction: '/create-pr',
        cwd,
        homeDir,
      }),
    ).rejects.toThrow('not found');
  });

  it('supports typo fallback directories for backward compatibility', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cook-command-instruction-test-'));
    const cwd = path.join(tempRoot, 'workspace');
    const homeDir = path.join(tempRoot, 'home');
    const typoCodexPath = path.join(cwd, '.codex', 'commads');
    await mkdir(typoCodexPath, { recursive: true });

    await Bun.write(path.join(typoCodexPath, 'ship.md'), 'from-typo-dir');

    const result = await resolveCommandInstruction({
      instruction: '/ship',
      cwd,
      homeDir,
    });

    expect(result.instruction).toBe('from-typo-dir');
    expect(result.sourcePath).toBe(path.join(typoCodexPath, 'ship.md'));
  });
});
