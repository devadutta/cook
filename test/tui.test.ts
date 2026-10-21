import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { shouldLaunchTui } from '../src/cli.ts';
import { listCommandAliases } from '../src/command-instruction.ts';
import { searchItems, toModelItems } from '../src/tui/components.ts';
import { optionSource, parseIntegerInput, parseListInput } from '../src/tui/settings.ts';

describe('shouldLaunchTui', () => {
  it('opens only for a bare `cook` on an interactive terminal', () => {
    expect(shouldLaunchTui([], () => true)).toBe(true);
    expect(shouldLaunchTui([], () => false)).toBe(false);
  });

  it('does not inspect the terminal when arguments are present', () => {
    let inspected = false;
    expect(shouldLaunchTui(['list files'], () => {
      inspected = true;
      return true;
    })).toBe(false);
    expect(inspected).toBe(false);
  });
});

describe('tui helpers', () => {
  it('ranks verbatim matches ahead of scattered fuzzy matches', () => {
    const ids = ['anthropic/claude-sonnet-4.6', 'anthropic/claude-opus-4.6', 'openai/gpt-5'];
    expect(searchItems(ids, 'opus 4.6', id => id)[0]).toBe('anthropic/claude-opus-4.6');
    expect(searchItems(ids, '', id => id)).toEqual(ids);
  });

  it('pins current and default models that the provider does not list', () => {
    const items = toModelItems([{ id: 'a', description: '1M ctx' }, { id: 'b' }], 'b', 'z');
    expect(items).toEqual([
      { value: 'z', label: 'z', description: 'cook default · not in provider list' },
      { value: 'a', label: 'a', description: '1M ctx' },
      { value: 'b', label: 'b', description: 'current' },
    ]);
    expect(toModelItems([], 'x', 'x')).toEqual([{ value: 'x', label: 'x', description: 'current' }]);
  });

  it('parses numeric and list inputs', () => {
    expect(parseIntegerInput('30_000')).toBe(30_000);
    expect(parseIntegerInput('1,048,576')).toBe(1_048_576);
    expect(parseIntegerInput('  ')).toBeUndefined();
    expect(() => parseIntegerInput('12.5')).toThrow('not a whole number');
    expect(parseListInput(' a.md, ,b.md ')).toEqual(['a.md', 'b.md']);
  });

  it('reports which config file sets an option', () => {
    const files = { global: { max_steps: 5, quiet: true }, local: { max_steps: 9 } };
    expect(optionSource(files, 'max_steps')).toBe('local');
    expect(optionSource(files, 'quiet')).toBe('global');
    expect(optionSource(files, 'debug')).toBe('default');
  });
});

describe('listCommandAliases', () => {
  it('lists markdown commands across command directories once', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cook-aliases-'));
    const cwd = path.join(root, 'ws');
    const home = path.join(root, 'home');
    await mkdir(path.join(cwd, '.cook', 'commands'), { recursive: true });
    await mkdir(path.join(home, '.claude', 'commands'), { recursive: true });
    await Bun.write(path.join(cwd, '.cook', 'commands', 'create-pr.md'), 'open a PR');
    await Bun.write(path.join(cwd, '.cook', 'commands', 'notes.txt'), 'ignored');
    await Bun.write(path.join(home, '.claude', 'commands', 'create-pr.md'), 'dupe');
    await Bun.write(path.join(home, '.claude', 'commands', 'review.md'), 'review');

    expect(await listCommandAliases(cwd, home)).toEqual(['create-pr', 'review']);
  });
});
