import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAgent } from '../src/agent.ts';
import { runApprovalFlow } from '../src/approval-flow.ts';
import { DEFAULT_CONFIG, EXIT_CODES } from '../src/defaults.ts';
import { createRuntimeConfig } from '../src/runtime-config.ts';
import type { AgentRunOptions } from '../src/types.ts';

type ResponseItem = Record<string, unknown>;

// A stand-in for the OpenAI Responses API that answers with queued output items.
const requests: Array<{ input: ResponseItem[] }> = [];
const queued: ResponseItem[][] = [];
let server: ReturnType<typeof Bun.serve>;
const savedEnv = { OPENAI_BASE_URL: process.env.OPENAI_BASE_URL, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
let scratch: string;

function message(text: string): ResponseItem {
  return {
    type: 'message',
    id: `msg_${requests.length}`,
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
}

function bashCall(command: string): ResponseItem {
  return {
    type: 'function_call',
    id: `fc_${requests.length}`,
    call_id: `call_${requests.length}`,
    name: 'Bash',
    arguments: JSON.stringify({ command, isMutating: true }),
    status: 'completed',
  };
}

function agentOptions(instruction: string): AgentRunOptions {
  const runtime = createRuntimeConfig(
    {
      ...DEFAULT_CONFIG,
      agents: { test: { provider: 'openai', model: 'gpt-test', ignore_agents_md: true } },
      default_agent: 'test',
    },
    {},
  );
  return {
    instruction,
    runtime: { ...runtime, cwd: scratch },
    stdin: { mode: 'none', bytes: 0, isText: true, preview: '' },
    global_system_path: path.join(scratch, 'none.md'),
    local_system_path: path.join(scratch, 'none.md'),
    logDebug: () => {},
    logToolCommand: () => {},
  };
}

/** The text of every input item after the instructions, for checking what a request sent. */
function inputTexts(index: number): string[] {
  const input = (requests[index]?.input ?? []).filter(item => item.role !== 'system' && item.role !== 'developer');
  return input.map(item => {
    if (item.type === 'function_call_output') {
      return `output: ${String(item.output)}`;
    }
    if (item.type === 'item_reference') {
      return `reference: ${String(item.id)}`;
    }
    const content = item.content;
    if (typeof content === 'string') {
      return content;
    }
    return Array.isArray(content)
      ? content.map(part => String((part as { text?: unknown }).text ?? '')).join('')
      : String(item.type);
  });
}

beforeAll(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), 'cook-conversation-'));
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.json() as { input: ResponseItem[] };
      requests.push(body);
      return Response.json({
        id: `resp_${requests.length}`,
        object: 'response',
        created_at: 1_700_000_000,
        model: 'gpt-test',
        output: queued.shift() ?? [message('done')],
        incomplete_details: null,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    },
  });
  process.env.OPENAI_BASE_URL = `http://localhost:${server.port}/v1`;
  process.env.OPENAI_API_KEY = 'test-key';
});

afterAll(() => {
  server.stop(true);
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

describe('conversations across turns', () => {
  it('sends earlier turns before the next task', async () => {
    requests.length = 0;
    queued.push([message('Noted: 42.')], [message('It was 42.')]);

    const first = await runAgent(agentOptions('Remember the number 42.'));
    expect(first.text).toBe('Noted: 42.');
    expect(first.messages).toHaveLength(2);

    const second = await runAgent({ ...agentOptions('Which number was it?'), history: first.messages });
    expect(second.text).toBe('It was 42.');

    const sent = inputTexts(1);
    expect(sent).toHaveLength(3);
    expect(sent[0]).toContain('Task: Remember the number 42.');
    // OpenAI stores responses, so the earlier answer goes back by reference.
    expect(sent[1]).toBe('reference: msg_0');
    expect(sent[2]).toContain('Task: Which number was it?');
    expect(second.messages).toHaveLength(4);
  });

  it('answers declined actions so the next turn can continue', async () => {
    requests.length = 0;
    queued.push([bashCall('touch kept.txt')], [message('Okay, nothing changed.')]);

    const flow = await runApprovalFlow({
      runAgent: ({ messages }) => runAgent({ ...agentOptions('Create kept.txt'), messages }),
      confirmApproval: async () => ({ kind: 'decline' }),
      printStdout: () => {},
      printStderr: () => {},
      canPromptForConfirmation: () => true,
    });
    expect(flow.exitCode).toBe(EXIT_CODES.DECLINED);
    expect(await Bun.file(path.join(scratch, 'kept.txt')).exists()).toBe(false);

    await runAgent({ ...agentOptions('Never mind.'), history: flow.messages });
    const sent = inputTexts(1);
    expect(sent[0]).toContain('Task: Create kept.txt');
    expect(sent).toContain('function_call');
    expect(sent.find(text => text.startsWith('output: '))).toContain('The user stopped this action.');
    expect(sent.at(-1)).toContain('Task: Never mind.');
  });

  it('stops when the turn is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runAgent({ ...agentOptions('Anything'), abortSignal: controller.signal })).rejects.toThrow();
  });
});
