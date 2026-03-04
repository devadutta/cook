import { describe, expect, it } from 'bun:test';
import {
  buildBaseInstructions,
  buildAgentRunStartPayload,
  createAgentCallSessionLogger,
  createToolCallSessionCallbacks,
  extractTerminalBashAnswer,
  mapExecuteResult,
  stopOnTerminalBash,
} from '../src/agent.ts';
import type { SessionEventType, SessionLogger } from '../src/types.ts';

describe('agent helpers', () => {
  it('disables isFinal guidance when raw bash output mode is off', () => {
    const instructions = buildBaseInstructions(false);
    expect(instructions).not.toContain('Set Bash isFinal=true');
    expect(instructions).toContain('Do not set Bash isFinal');
    expect(instructions).toContain('Every Bash call must include isMutating.');
    expect(instructions).toContain(
      'Set Bash isMutating=true only for task-impacting state changes.',
    );
    expect(instructions).toContain(
      'Set Bash isMutating=false for read-only commands and ephemeral scratch effects',
    );
  });

  it('includes isFinal guidance when raw bash output mode is on', () => {
    const instructions = buildBaseInstructions(true);
    expect(instructions).toContain('Set Bash isFinal=true');
    expect(instructions).toContain('Every Bash call must include isMutating.');
  });

  it('appends local date, time, and timezone context', () => {
    const instructions = buildBaseInstructions(false);
    expect(instructions).toMatch(/Current local date: \d{4}-\d{2}-\d{2}\./);
    expect(instructions).toMatch(/Current local time: \d{2}:\d{2}:\d{2}\./);
    expect(instructions).toMatch(/Current timezone: .+ \(UTC[+-]\d{2}:\d{2}\)\./);
  });

  it('appends host machine context for command compatibility', () => {
    const instructions = buildBaseInstructions(false);
    expect(instructions).toContain(
      'Host machine context (this is the machine you are running on; use it to choose compatible bash commands):',
    );
    expect(instructions).toContain('system=');
    expect(instructions).toContain('kernel=');
    expect(instructions).toContain('os=');
    expect(instructions).toContain('hardware=');
    expect(instructions).not.toContain('runtime=bun/');
  });

  it('logs tool call start/finish payloads with prompt and io details', () => {
    const events: Array<{ type: SessionEventType; payload: Record<string, unknown> }> = [];
    const logger: SessionLogger = {
      enabled: true,
      session_id: 'session-1',
      session_dir: '/tmp/session-1',
      logEvent(type, payload) {
        events.push({ type, payload: payload ?? {} });
      },
      async finish() {
        // no-op for unit test
      },
    };

    const callbacks = createToolCallSessionCallbacks({
      runId: 'run-1',
      prompt: 'Task: inspect README',
      sessionLogger: logger,
    });

    callbacks.onToolCallStart({
      stepNumber: 2,
      toolCall: {
        toolCallId: 'tool-123',
        toolName: 'Read',
        input: { path: 'README.md' },
      },
    });

    callbacks.onToolCallFinish({
      stepNumber: 2,
      durationMs: 15,
      success: true,
      toolCall: {
        toolCallId: 'tool-123',
        toolName: 'Read',
        input: { path: 'README.md' },
      },
      output: { ok: true, content: '...' },
    });

    expect(events[0]?.type).toBe('tool.call.start');
    expect(events[0]?.payload.mode).toBe('execute');
    expect(events[0]?.payload.prompt).toBe('Task: inspect README');
    expect(events[0]?.payload.tool_name).toBe('Read');
    expect(events[0]?.payload.input).toEqual({ path: 'README.md' });

    expect(events[1]?.type).toBe('tool.call.finish');
    expect(events[1]?.payload.success).toBe(true);
    expect(events[1]?.payload.output).toEqual({ ok: true, content: '...' });
    expect(events[1]?.payload.duration_ms).toBe(15);
  });

  it('builds run-start payload with full prompt initialization context', () => {
    const payload = buildAgentRunStartPayload({
      runId: 'run-ctx-1',
      instruction: 'Summarize changes',
      prompt: 'Task: summarize changes',
      cwd: '/tmp/workspace',
      maxSteps: 8,
      systemPrompt: '[SYSTEM:path]\nbe strict',
      fullInstructions: 'base instructions\n\n[SYSTEM:path]\nbe strict',
      continuationMessageCount: 2,
    });

    expect(payload.run_id).toBe('run-ctx-1');
    expect(payload.mode).toBe('execute');
    expect(payload.system_prompt).toBe('[SYSTEM:path]\nbe strict');
    expect(payload.system_prompt_length).toBe('[SYSTEM:path]\nbe strict'.length);
    expect(payload.full_instructions).toBe('base instructions\n\n[SYSTEM:path]\nbe strict');
    expect(payload.full_instructions_length).toBe(
      'base instructions\n\n[SYSTEM:path]\nbe strict'.length,
    );
    expect(payload.continuation_message_count).toBe(2);
    expect(payload.is_continuation).toBe(true);
  });

  it('logs agent call start/finish with prompt and system payloads', () => {
    const events: Array<{ type: SessionEventType; payload: Record<string, unknown> }> = [];
    const logger: SessionLogger = {
      enabled: true,
      session_id: 'session-1',
      session_dir: '/tmp/session-1',
      logEvent(type, payload) {
        events.push({ type, payload: payload ?? {} });
      },
      async finish() {
        // no-op for unit test
      },
    };

    const callLogger = createAgentCallSessionLogger({
      runId: 'run-1',
      callId: 'call-1',
      mode: 'execute',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      prompt: 'Task: inspect README',
      systemPrompt: '[SYSTEM:file]\npolicy',
      fullInstructions: 'base\n\n[SYSTEM:file]\npolicy',
      continuationMessageCount: 1,
      inputMessageCount: 2,
      sessionLogger: logger,
    });

    callLogger.onCallStart();
    callLogger.onCallFinish({
      success: true,
      durationMs: 42,
      responseMessageCount: 3,
      pendingApprovalCount: 1,
      text: 'done',
    });

    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe('agent.call.start');
    expect(events[0]?.payload.call_id).toBe('call-1');
    expect(events[0]?.payload.system_prompt).toBe('[SYSTEM:file]\npolicy');
    expect(events[0]?.payload.full_instructions).toBe('base\n\n[SYSTEM:file]\npolicy');
    expect(events[0]?.payload.is_continuation).toBe(true);
    expect(events[1]?.type).toBe('agent.call.finish');
    expect(events[1]?.payload.success).toBe(true);
    expect(events[1]?.payload.duration_ms).toBe(42);
    expect(events[1]?.payload.response_message_count).toBe(3);
    expect(events[1]?.payload.pending_approval_count).toBe(1);
    expect(events[1]?.payload.text).toBe('done');
  });

  it('logs serialized errors for failed agent calls', () => {
    const events: Array<{ type: SessionEventType; payload: Record<string, unknown> }> = [];
    const logger: SessionLogger = {
      enabled: true,
      session_id: 'session-1',
      session_dir: '/tmp/session-1',
      logEvent(type, payload) {
        events.push({ type, payload: payload ?? {} });
      },
      async finish() {
        // no-op for unit test
      },
    };

    const callLogger = createAgentCallSessionLogger({
      runId: 'run-1',
      callId: 'call-2',
      mode: 'execute',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      prompt: 'Task: inspect README',
      systemPrompt: null,
      fullInstructions: 'base',
      continuationMessageCount: 0,
      inputMessageCount: 1,
      sessionLogger: logger,
    });

    callLogger.onCallStart();
    callLogger.onCallFinish({
      success: false,
      durationMs: 10,
      error: new Error('model failed'),
    });

    expect(events[1]?.type).toBe('agent.call.finish');
    expect(events[1]?.payload.success).toBe(false);
    expect(events[1]?.payload.error).toEqual({
      name: 'Error',
      message: 'model failed',
      stack: expect.any(String),
    });
  });

  it('maps execute output with pending approvals and response messages', () => {
    const result = mapExecuteResult(
      [],
      '  summary line  ',
      [
        {
          approvalId: 'approval-1',
          toolCallId: 'tool-1',
          toolName: 'Write',
          input: { path: 'out.txt' },
        },
      ],
      [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
        },
      ],
    );

    expect(result).toEqual({
      text: 'summary line',
      mutationPlan: [],
      pendingApprovals: [
        {
          approvalId: 'approval-1',
          toolCallId: 'tool-1',
          toolName: 'Write',
          input: { path: 'out.txt' },
        },
      ],
      responseMessages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
        },
      ],
    });
  });

  it('maps terminal metadata when provided', () => {
    const result = mapExecuteResult([], 'done', [], [], {
      source: 'bash',
      command: 'find . -name "*.png"',
      cwd: '/tmp/work',
      exitCode: 0,
    });

    expect(result.terminal).toEqual({
      source: 'bash',
      command: 'find . -name "*.png"',
      cwd: '/tmp/work',
      exitCode: 0,
    });
  });

  it('extracts terminal bash output from stdout', () => {
    const terminal = extractTerminalBashAnswer([
      {
        toolName: 'Bash',
        output: {
          command: 'find . -name "*.png"',
          cwd: '/tmp/work',
          isFinal: true,
          exitCode: 0,
          stdout: 'a.png\nb.png\n',
          stderr: '',
        },
      },
    ]);

    expect(terminal).toEqual({
      text: 'a.png\nb.png\n',
      terminal: {
        source: 'bash',
        command: 'find . -name "*.png"',
        cwd: '/tmp/work',
        exitCode: 0,
      },
    });
  });

  it('extracts terminal bash output from stderr when stdout is empty', () => {
    const terminal = extractTerminalBashAnswer([
      {
        toolName: 'Bash',
        output: {
          command: 'echo hi 1>&2',
          cwd: '/tmp/work',
          isFinal: true,
          exitCode: 0,
          stdout: '',
          stderr: 'hi\n',
        },
      },
    ]);

    expect(terminal?.text).toBe('hi\n');
    expect(terminal?.terminal).toEqual({
      source: 'bash',
      command: 'echo hi 1>&2',
      cwd: '/tmp/work',
      exitCode: 0,
    });
  });

  it('does not extract terminal bash output when exitCode is non-zero', () => {
    const terminal = extractTerminalBashAnswer([
      {
        toolName: 'Bash',
        output: {
          command: 'find . -name "*.png"',
          cwd: '/tmp/work',
          isFinal: true,
          exitCode: 1,
          stdout: '',
          stderr: 'failed',
        },
      },
    ]);

    expect(terminal).toBeNull();
  });

  it('keeps terminal stop condition false for non-terminal bash output', () => {
    const shouldStop = stopOnTerminalBash({
      steps: [
        {
          toolResults: [
            {
              toolName: 'Bash',
              output: {
                command: 'ls',
                cwd: '/tmp/work',
                isFinal: false,
                exitCode: 0,
                stdout: 'a.txt\n',
                stderr: '',
              },
            },
          ],
        },
      ] as Parameters<typeof stopOnTerminalBash>[0]['steps'],
    });

    expect(shouldStop).toBe(false);
  });

  it('stops on successful terminal bash output in the latest step', () => {
    const shouldStop = stopOnTerminalBash({
      steps: [
        {
          toolResults: [
            {
              toolName: 'Bash',
              output: {
                command: 'find . -name "*.jpg"',
                cwd: '/tmp/work',
                isFinal: true,
                exitCode: 0,
                stdout: 'x.jpg\n',
                stderr: '',
              },
            },
          ],
        },
      ] as Parameters<typeof stopOnTerminalBash>[0]['steps'],
    });

    expect(shouldStop).toBe(true);
  });
});
