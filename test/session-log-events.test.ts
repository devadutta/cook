import { describe, expect, it } from 'bun:test';
import { logConfirmationDecision } from '../src/session-log-events.ts';
import type {
  PendingToolApproval,
  SessionEventType,
  SessionLogger,
} from '../src/types.ts';

describe('session log confirmation events', () => {
  it('logs confirmation decisions with approval metadata', () => {
    const events: Array<{ type: SessionEventType; payload: Record<string, unknown> }> = [];
    const logger: SessionLogger = {
      enabled: true,
      session_id: 'session-1',
      session_dir: '/tmp/session-1',
      logEvent(type, payload) {
        events.push({ type, payload: payload ?? {} });
      },
      async finish() {
        // no-op
      },
    };

    const approval: PendingToolApproval = {
      approvalId: 'approval-1',
      toolCallId: 'tool-1',
      toolName: 'Bash',
      input: { command: 'echo hi > out.txt', cwd: '.' },
    };

    logConfirmationDecision(logger, approval, {
      kind: 'guidance',
      text: 'use a different branch',
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('confirmation.decision');
    expect(events[0]?.payload.decision).toBe('guidance');
    expect(events[0]?.payload.guidance).toBe('use a different branch');
    expect(events[0]?.payload.approval_id).toBe('approval-1');
    expect(events[0]?.payload.tool_call_id).toBe('tool-1');
    expect(events[0]?.payload.tool_name).toBe('Bash');
    expect(events[0]?.payload.input).toEqual({ command: 'echo hi > out.txt', cwd: '.' });
  });
});
