import { describe, expect, it } from 'bun:test';
import {
  createDebugLogger,
  createToolCommandLogger,
  formatAgentLoaded,
  formatMutationPlan,
  formatToolCommand,
} from '../src/output.ts';
import type { MutationRecord } from '../src/types.ts';

describe('output', () => {
  it('createDebugLogger emits only when enabled', () => {
    const disabled: string[] = [];
    const enabled: string[] = [];

    createDebugLogger(false, message => disabled.push(message))('hidden');
    createDebugLogger(true, message => enabled.push(message))('visible');

    expect(disabled).toEqual([]);
    expect(enabled.length).toBe(1);
    expect(enabled[0]).toContain('[debug]');
    expect(enabled[0]).toContain('visible');
  });

  it('createToolCommandLogger emits only when enabled', () => {
    const disabled: string[] = [];
    const enabled: string[] = [];

    createToolCommandLogger(false, message => disabled.push(message))('Bash', 'ls -la');
    createToolCommandLogger(true, message => enabled.push(message))('Bash', 'ls -la');

    expect(disabled).toEqual([]);
    expect(enabled.length).toBe(1);
    expect(enabled[0]).toContain('[bash]');
    expect(enabled[0]).toContain('ls -la');
  });

  it('formatToolCommand prefixes with lower-case tool name', () => {
    const line = formatToolCommand('Write', '/tmp/a.txt (12 chars, createDirs=false)');
    expect(line).toContain('[write] /tmp/a.txt (12 chars, createDirs=false)');
  });

  it('formatMutationPlan returns readable numbered plan output', () => {
    const plan: MutationRecord[] = [
      {
        tool: 'Write',
        summary: '/tmp/a.txt (12 chars)',
        input: {
          path: '/tmp/a.txt',
          content: 'hello world!',
          createDirs: false,
        },
      },
      {
        tool: 'Bash',
        summary: 'mv a.txt b.txt',
        input: {
          command: 'mv a.txt b.txt',
          cwd: '.',
        },
      },
    ];

    const formatted = formatMutationPlan(plan, 'Pending mutating actions:');
    expect(formatted).toContain('Pending mutating actions:');
    expect(formatted).toContain('1. Write: /tmp/a.txt (12 chars)');
    expect(formatted).toContain('2. Bash: mv a.txt b.txt');
  });

  it('formatAgentLoaded prefixes with cook tag and agent name', () => {
    const line = formatAgentLoaded('fast');
    expect(line).toContain('[cook]');
    expect(line).toContain('fast');
    expect(line).not.toContain('API_KEY');
  });
});
