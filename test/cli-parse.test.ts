import { describe, expect, it } from 'bun:test';
import { parseCli } from '../src/cli-parse.ts';

describe('parseCli', () => {
  it('parses unquoted instruction words', () => {
    const parsed = parseCli(['bun', 'cook', 'find', 'all', 'python', 'files']);
    expect(parsed.instruction).toBe('find all python files');
  });

  it('keeps unknown dash tokens as instruction while parsing known options', () => {
    const parsed = parseCli([
      'bun',
      'cook',
      'find',
      '--older-than',
      '60d',
      '--dry-run',
      '--debug',
      '--quiet',
    ]);

    expect(parsed.instruction).toBe('find --older-than 60d');
    expect(parsed.flags.dryRun).toBe(true);
    expect(parsed.flags.debug).toBe(true);
    expect(parsed.flags.quiet).toBe(true);
  });

  it('keeps --verbose as a debug alias', () => {
    const parsed = parseCli([
      'bun',
      'cook',
      'summarize',
      '--verbose',
    ]);

    expect(parsed.flags.verbose).toBe(true);
  });

  it('parses --agent and keeps removed --model flag in instruction', () => {
    const parsed = parseCli([
      'bun',
      'cook',
      'summarize',
      '--model',
      'openai/gpt-4.1-mini',
      '--agent',
      'fast',
    ]);

    expect(parsed.flags.agent).toBe('fast');
    expect(parsed.instruction).toBe('summarize --model openai/gpt-4.1-mini');
  });

  it('parses --raw as a cook flag', () => {
    const parsed = parseCli([
      'bun',
      'cook',
      'find',
      'dns',
      '--raw',
    ]);

    expect(parsed.flags.raw).toBe(true);
    expect(parsed.instruction).toBe('find dns');
  });
});
