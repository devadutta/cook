import { describe, expect, it } from 'bun:test';
import { runApprovalFlow } from '../src/approval-flow.ts';
import { EXIT_CODES } from '../src/defaults.ts';
import type { AgentRunResult, PendingToolApproval } from '../src/types.ts';

function approval(id: string, toolName: PendingToolApproval['toolName']): PendingToolApproval {
  return {
    approvalId: id,
    toolCallId: `${id}-tool-call`,
    toolName,
    input:
      toolName === 'Bash'
        ? { command: 'echo hi > out.txt', cwd: '.' }
        : toolName === 'Write'
          ? { path: 'out.txt', content: 'hi' }
          : { path: 'out.txt', edits: [{ find: 'a', replace: 'b' }] },
  };
}

function runResult(
  partial: Partial<AgentRunResult> & Pick<AgentRunResult, 'text'>,
): AgentRunResult {
  return {
    text: partial.text,
    mutationPlan: partial.mutationPlan ?? [],
    pendingApprovals: partial.pendingApprovals ?? [],
    responseMessages: partial.responseMessages ?? [],
    ...(partial.terminal ? { terminal: partial.terminal } : {}),
  };
}

describe('runApprovalFlow', () => {
  it('approves a mutation and continues execution', async () => {
    const runs: AgentRunResult[] = [
      runResult({
        text: '',
        pendingApprovals: [approval('approval-1', 'Bash')],
        responseMessages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool-approval-request',
                approvalId: 'approval-1',
                toolCallId: 'approval-1-tool-call',
              },
            ],
          },
        ],
      }),
      runResult({ text: 'done' }),
    ];
    const runInputs: Array<{ messages?: unknown[] }> = [];

    const result = await runApprovalFlow({
      runAgent: async options => {
        runInputs.push({ messages: options.messages as unknown[] | undefined });
        return runs.shift() ?? runResult({ text: '' });
      },
      confirmApproval: async () => ({ kind: 'approve' }),
      printStdout: () => {},
      printStderr: () => {},
      canPromptForConfirmation: () => true,
    });

    expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(runInputs).toHaveLength(2);

    const continuation = runInputs[1]?.messages;
    expect(Array.isArray(continuation)).toBe(true);
    expect(continuation?.[0]).toEqual({
      role: 'assistant',
      content: [
        {
          type: 'tool-approval-request',
          approvalId: 'approval-1',
          toolCallId: 'approval-1-tool-call',
        },
      ],
    });
    expect(continuation?.[1]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-approval-response',
          approvalId: 'approval-1',
          approved: true,
          reason: undefined,
        },
      ],
    });
  });

  it('returns declined when user declines confirmation', async () => {
    const result = await runApprovalFlow({
      runAgent: async () =>
        runResult({
          text: '',
          pendingApprovals: [approval('approval-1', 'Write')],
          responseMessages: [],
        }),
      confirmApproval: async () => ({ kind: 'decline' }),
      printStdout: () => {},
      printStderr: () => {},
      canPromptForConfirmation: () => true,
    });

    expect(result.exitCode).toBe(EXIT_CODES.DECLINED);
  });

  it('completes when a terminal bash answer is returned with no pending approvals', async () => {
    const stdout: string[] = [];
    const result = await runApprovalFlow({
      runAgent: async () =>
        runResult({
          text: 'a.png\nb.png\n',
          terminal: {
            source: 'bash',
            command: 'find . -name "*.png"',
            cwd: '/tmp/work',
            exitCode: 0,
          },
        }),
      confirmApproval: async () => ({ kind: 'approve' }),
      printStdout: message => {
        stdout.push(message);
      },
      printStderr: () => {},
      canPromptForConfirmation: () => true,
    });

    expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(stdout).toEqual(['a.png\nb.png\n']);
  });

  it('supports approve_all for current and future prompts in the run', async () => {
    const runs: AgentRunResult[] = [
      runResult({
        text: '',
        pendingApprovals: [
          approval('approval-1', 'Write'),
          approval('approval-2', 'Edit'),
          approval('approval-3', 'Bash'),
        ],
        responseMessages: [],
      }),
      runResult({ text: 'done' }),
    ];
    const decisions: Array<{ approvalId: string; decision: string }> = [];
    const result = await runApprovalFlow({
      runAgent: async () => runs.shift() ?? runResult({ text: '' }),
      confirmApproval: async () => ({ kind: 'approve_all' }),
      printStdout: () => {},
      printStderr: () => {},
      canPromptForConfirmation: () => true,
      onConfirmationDecision: (item, decision) => {
        decisions.push({ approvalId: item.approvalId, decision: decision.kind });
      },
    });

    expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(decisions).toEqual([
      { approvalId: 'approval-1', decision: 'approve_all' },
      { approvalId: 'approval-2', decision: 'approve_all' },
      { approvalId: 'approval-3', decision: 'approve_all' },
    ]);
  });

  it('uses guidance to deny the current pending batch and continue', async () => {
    const runs: AgentRunResult[] = [
      runResult({
        text: '',
        pendingApprovals: [approval('approval-1', 'Write'), approval('approval-2', 'Edit')],
        responseMessages: [],
      }),
      runResult({ text: 'replanned' }),
    ];
    const runInputs: Array<{ messages?: unknown[] }> = [];

    const result = await runApprovalFlow({
      runAgent: async options => {
        runInputs.push({ messages: options.messages as unknown[] | undefined });
        return runs.shift() ?? runResult({ text: '' });
      },
      confirmApproval: async () => ({ kind: 'guidance', text: 'skip edits and summarize only' }),
      printStdout: () => {},
      printStderr: () => {},
      canPromptForConfirmation: () => true,
    });

    expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
    const continuation = runInputs[1]?.messages;
    expect(continuation?.[0]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-approval-response',
          approvalId: 'approval-1',
          approved: false,
          reason: 'skip edits and summarize only',
        },
        {
          type: 'tool-approval-response',
          approvalId: 'approval-2',
          approved: false,
          reason: 'skip edits and summarize only',
        },
      ],
    });

    const guidanceMessage = continuation?.[1] as
      | { role?: unknown; content?: unknown }
      | undefined;
    expect(guidanceMessage?.role).toBe('user');
    expect(typeof guidanceMessage?.content).toBe('string');

    const guidanceText = guidanceMessage?.content as string;
    expect(guidanceText).toContain(
      'User correction from confirmation prompt: "skip edits and summarize only".',
    );
    expect(guidanceText).toContain('This applies for the rest of this run.');
    expect(guidanceText).toContain(
      'Do not repeat denied mutating actions unchanged; revise your next proposal accordingly.',
    );
    expect(guidanceText).toContain('Denied actions:');
    expect(guidanceText).toContain('1. Write: out.txt (2 chars)');
    expect(guidanceText).toContain('2. Edit: out.txt (1 edit block(s))');
  });

  it('keeps guidance correction in continuation for later approvals in the same run', async () => {
    const runs: AgentRunResult[] = [
      runResult({
        text: '',
        pendingApprovals: [approval('approval-1', 'Write')],
        responseMessages: [],
      }),
      runResult({
        text: '',
        pendingApprovals: [approval('approval-2', 'Bash')],
        responseMessages: [],
      }),
      runResult({ text: 'done' }),
    ];
    const runInputs: Array<{ messages?: unknown[] }> = [];
    let confirmCalls = 0;

    const result = await runApprovalFlow({
      runAgent: async options => {
        runInputs.push({ messages: options.messages as unknown[] | undefined });
        return runs.shift() ?? runResult({ text: '' });
      },
      confirmApproval: async () => {
        confirmCalls += 1;
        if (confirmCalls === 1) {
          return { kind: 'guidance', text: 'only summarize and avoid file changes' };
        }

        return { kind: 'approve' };
      },
      printStdout: () => {},
      printStderr: () => {},
      canPromptForConfirmation: () => true,
    });

    expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
    const continuation = runInputs[1]?.messages ?? [];
    const correctionMessage = continuation.find(message => {
      if (typeof message !== 'object' || message === null) {
        return false;
      }

      const record = message as { role?: unknown; content?: unknown };
      return (
        record.role === 'user' &&
        typeof record.content === 'string' &&
        record.content.includes(
          'User correction from confirmation prompt: "only summarize and avoid file changes".',
        )
      );
    });

    expect(correctionMessage).toBeDefined();
  });

  it('appends new guidance corrections and keeps latest correction last', async () => {
    const runs: AgentRunResult[] = [
      runResult({
        text: '',
        pendingApprovals: [approval('approval-1', 'Write')],
        responseMessages: [],
      }),
      runResult({
        text: '',
        pendingApprovals: [approval('approval-2', 'Edit')],
        responseMessages: [],
      }),
      runResult({
        text: '',
        pendingApprovals: [approval('approval-3', 'Bash')],
        responseMessages: [],
      }),
      runResult({ text: 'done' }),
    ];
    const runInputs: Array<{ messages?: unknown[] }> = [];
    let confirmCalls = 0;

    const result = await runApprovalFlow({
      runAgent: async options => {
        runInputs.push({ messages: options.messages as unknown[] | undefined });
        return runs.shift() ?? runResult({ text: '' });
      },
      confirmApproval: async () => {
        confirmCalls += 1;
        if (confirmCalls === 1) {
          return { kind: 'guidance', text: 'first correction' };
        }

        if (confirmCalls === 2) {
          return { kind: 'guidance', text: 'second correction' };
        }

        return { kind: 'approve' };
      },
      printStdout: () => {},
      printStderr: () => {},
      canPromptForConfirmation: () => true,
    });

    expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
    const continuation = runInputs[2]?.messages ?? [];
    const correctionMessages = continuation
      .filter(message => {
        if (typeof message !== 'object' || message === null) {
          return false;
        }

        const record = message as { role?: unknown; content?: unknown };
        return (
          record.role === 'user' &&
          typeof record.content === 'string' &&
          record.content.includes('User correction from confirmation prompt:')
        );
      })
      .map(message => (message as { content: string }).content);

    expect(correctionMessages).toHaveLength(2);
    expect(correctionMessages[0]).toContain('"first correction"');
    expect(correctionMessages[1]).toContain('"second correction"');
  });

  it('fails only when approval is required and tty is unavailable', async () => {
    let confirmCalls = 0;
    const result = await runApprovalFlow({
      runAgent: async () =>
        runResult({
          text: '',
          pendingApprovals: [approval('approval-1', 'Bash')],
          responseMessages: [],
        }),
      confirmApproval: async () => {
        confirmCalls += 1;
        return { kind: 'approve' };
      },
      printStdout: () => {},
      printStderr: () => {},
      canPromptForConfirmation: () => false,
    });

    expect(result.exitCode).toBe(EXIT_CODES.NON_TTY_CONFIRMATION_REQUIRED);
    expect(confirmCalls).toBe(0);
  });
});
