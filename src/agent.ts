import { ToolLoopAgent, stepCountIs } from 'ai';
import type { StopCondition } from 'ai';
import type { ModelMessage } from '@ai-sdk/provider-utils';
import { randomUUID } from 'node:crypto';
import { createGateway } from '@ai-sdk/gateway';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createOpenAI } from '@ai-sdk/openai';
import { createToolSet } from './tools/index.ts';
import type {
  AgentRunOptions,
  AgentRunResult,
  PendingToolApproval,
  ToolRuntime,
} from './types.ts';
import { buildSystemPrompt } from './system-prompt.ts';

function formatLocalDateTimeContext(now = new Date()): string {
  const pad2 = (value: number): string => value.toString().padStart(2, '0');
  const date = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const time = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local';

  const offsetTotalMinutes = -now.getTimezoneOffset();
  const sign = offsetTotalMinutes >= 0 ? '+' : '-';
  const absOffsetMinutes = Math.abs(offsetTotalMinutes);
  const offsetHours = pad2(Math.floor(absOffsetMinutes / 60));
  const offsetMinutes = pad2(absOffsetMinutes % 60);
  const offset = `UTC${sign}${offsetHours}:${offsetMinutes}`;

  return `Current local date: ${date}. Current local time: ${time}. Current timezone: ${timeZone} (${offset}).`;
}

export function buildBaseInstructions(rawBashOutput: boolean): string {
  return [
    'You are cook, a shell-native micro-agent.',
    'You must solve tasks only with the available tools: Read, Write, Edit, Bash.',
    'Prefer Read and non-mutating Bash for discovery, then Edit/Write for focused changes.',
    'Every Bash call must include isMutating.',
    'Set Bash isMutating=true only for task-impacting state changes.',
    'Set Bash isMutating=false for read-only commands and ephemeral scratch effects (for example redirecting output to /dev/null or temporary files).',
    rawBashOutput
      ? 'Set Bash isFinal=true only when raw command output should be returned directly as the final answer.'
      : 'Do not set Bash isFinal; raw Bash terminal output mode is disabled for this run.',
    'Do not invent tools or capabilities.',
    'A denied tool execution reason is an explicit user correction that must be followed.',
    'Do not repeat a denied mutating action unchanged.',
    'When an action is denied, revise your next proposed action to satisfy the user correction.',
    'Return concise final output suitable for stdout in shell pipelines.',
    'Do not wrap final output in markdown fences unless explicitly requested.',
    formatLocalDateTimeContext(),
  ].join(' ');
}

function stdinSection(stdin: AgentRunOptions['stdin']): string {
  if (stdin.mode === 'none') {
    return 'No stdin was provided.';
  }

  if (stdin.mode === 'inline') {
    return [
      `Stdin mode: inline text (${stdin.bytes} bytes).`,
      'Stdin content follows between markers:',
      '<<<STDIN',
      stdin.inlineText ?? '',
      'STDIN>>>',
    ].join('\n');
  }

  return [
    `Stdin mode: temp-file (${stdin.bytes} bytes).`,
    `Path: ${stdin.tempFilePath}`,
    `Preview: ${stdin.preview || '<empty>'}`,
    'Use Read or Bash as needed to process the file.',
  ].join('\n');
}

function buildPrompt(options: AgentRunOptions): string {
  return [
    'Mode: execute requested task.',
    `Working directory: ${options.runtime.cwd}`,
    stdinSection(options.stdin),
    `Task: ${options.instruction}`,
    'If this is a rename/refactor request, execute actions directly using tools.',
  ].join('\n\n');
}

function createProviderModel(options: AgentRunOptions) {
  const { provider, model } = options.runtime.agent;

  if (provider === 'gateway') {
    const gatewayApiKey =
      options.runtime.ai_gateway_api_key ?? process.env.AI_GATEWAY_API_KEY;
    const gateway = createGateway({
      apiKey: gatewayApiKey,
    });
    return gateway(model);
  }

  if (provider === 'openai') {
    return createOpenAI()(model);
  }

  if (provider === 'anthropic') {
    return createAnthropic()(model);
  }

  if (provider === 'google') {
    return createGoogleGenerativeAI()(model);
  }

  return createGroq()(model);
}

function serializeError(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return error;
}

function isToolApprovalRequestPart(
  part: unknown,
): part is {
  type: 'tool-approval-request';
  approvalId: string;
  toolCall: { toolCallId: string; toolName: string; input: unknown };
} {
  if (typeof part !== 'object' || part === null) {
    return false;
  }

  const record = part as Record<string, unknown>;
  if (record.type !== 'tool-approval-request') {
    return false;
  }

  const approvalId = record.approvalId;
  const toolCall = record.toolCall;
  if (typeof approvalId !== 'string') {
    return false;
  }

  if (typeof toolCall !== 'object' || toolCall === null) {
    return false;
  }

  const call = toolCall as Record<string, unknown>;
  return typeof call.toolCallId === 'string' && typeof call.toolName === 'string';
}

function extractPendingApprovals(parts: unknown[]): PendingToolApproval[] {
  const pending: PendingToolApproval[] = [];

  for (const part of parts) {
    if (!isToolApprovalRequestPart(part)) {
      continue;
    }

    pending.push({
      approvalId: part.approvalId,
      toolCallId: part.toolCall.toolCallId,
      toolName: part.toolCall.toolName,
      input: part.toolCall.input,
    });
  }

  return pending;
}

function buildInputMessages(
  prompt: string,
  continuationMessages: ModelMessage[] | undefined,
): ModelMessage[] {
  const initialUserMessage: ModelMessage = {
    role: 'user',
    content: prompt,
  };

  if (!continuationMessages || continuationMessages.length === 0) {
    return [initialUserMessage];
  }

  return [initialUserMessage, ...continuationMessages];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  return value as Record<string, unknown>;
}

export function extractTerminalBashAnswer(
  toolResults: Array<{ toolName: string; output: unknown }>,
): {
  text: string;
  terminal: NonNullable<AgentRunResult['terminal']>;
} | null {
  for (let index = toolResults.length - 1; index >= 0; index -= 1) {
    const toolResult = toolResults[index];
    if (!toolResult || toolResult.toolName !== 'Bash') {
      continue;
    }

    const output = asRecord(toolResult.output);
    if (!output) {
      continue;
    }

    if (output.isFinal !== true) {
      continue;
    }

    if (output.exitCode !== 0) {
      continue;
    }

    const command = output.command;
    const cwd = output.cwd;
    if (typeof command !== 'string' || typeof cwd !== 'string') {
      continue;
    }

    const stdout = typeof output.stdout === 'string' ? output.stdout : '';
    const stderr = typeof output.stderr === 'string' ? output.stderr : '';

    return {
      text: stdout || stderr,
      terminal: {
        source: 'bash',
        command,
        cwd,
        exitCode: 0,
      },
    };
  }

  return null;
}

export const stopOnTerminalBash: StopCondition<any> = ({ steps }) => {
  const lastStep = steps[steps.length - 1];
  if (!lastStep) {
    return false;
  }

  return extractTerminalBashAnswer(lastStep.toolResults) !== null;
};

export function mapExecuteResult(
  mutationPlan: AgentRunResult['mutationPlan'],
  text: string,
  pendingApprovals: PendingToolApproval[],
  responseMessages: ModelMessage[],
  terminal?: AgentRunResult['terminal'],
): AgentRunResult {
  return {
    text: text.trim(),
    mutationPlan,
    pendingApprovals,
    responseMessages,
    ...(terminal ? { terminal } : {}),
  };
}

export function buildAgentRunStartPayload(options: {
  runId: string;
  instruction: string;
  prompt: string;
  cwd: string;
  maxSteps: number;
  systemPrompt: string | null;
  fullInstructions: string;
  continuationMessageCount: number;
}): Record<string, unknown> {
  return {
    run_id: options.runId,
    mode: 'execute',
    instruction: options.instruction,
    prompt: options.prompt,
    cwd: options.cwd,
    max_steps: options.maxSteps,
    system_prompt: options.systemPrompt,
    system_prompt_length: options.systemPrompt?.length ?? 0,
    full_instructions: options.fullInstructions,
    full_instructions_length: options.fullInstructions.length,
    continuation_message_count: options.continuationMessageCount,
    is_continuation: options.continuationMessageCount > 0,
  };
}

export function createToolCallSessionCallbacks(
  options: {
    runId: string;
    prompt: string;
    sessionLogger: AgentRunOptions['sessionLogger'];
  },
): {
  onToolCallStart: (event: {
    stepNumber?: number;
    toolCall: { toolCallId: string; toolName: string; input: unknown };
  }) => void;
  onToolCallFinish: (event: {
    stepNumber?: number;
    durationMs: number;
    success: boolean;
    toolCall: { toolCallId: string; toolName: string; input: unknown };
    output?: unknown;
    error?: unknown;
  }) => void;
} {
  return {
    onToolCallStart: event => {
      options.sessionLogger?.logEvent('tool.call.start', {
        run_id: options.runId,
        mode: 'execute',
        prompt: options.prompt,
        step_number: event.stepNumber ?? null,
        tool_name: event.toolCall.toolName,
        tool_call_id: event.toolCall.toolCallId,
        input: event.toolCall.input,
      });
    },
    onToolCallFinish: event => {
      options.sessionLogger?.logEvent('tool.call.finish', {
        run_id: options.runId,
        mode: 'execute',
        prompt: options.prompt,
        step_number: event.stepNumber ?? null,
        tool_name: event.toolCall.toolName,
        tool_call_id: event.toolCall.toolCallId,
        input: event.toolCall.input,
        success: event.success,
        output: event.success ? event.output : undefined,
        error: event.success ? undefined : serializeError(event.error),
        duration_ms: event.durationMs,
      });
    },
  };
}

export function createAgentCallSessionLogger(
  options: {
    runId: string;
    callId: string;
    mode: 'execute';
    provider: string;
    model: string;
    prompt: string;
    systemPrompt: string | null;
    fullInstructions: string;
    continuationMessageCount: number;
    inputMessageCount: number;
    sessionLogger: AgentRunOptions['sessionLogger'];
  },
): {
  onCallStart: () => void;
  onCallFinish: (event: {
    success: boolean;
    durationMs: number;
    responseMessageCount?: number;
    pendingApprovalCount?: number;
    text?: string;
    error?: unknown;
  }) => void;
} {
  return {
    onCallStart: () => {
      options.sessionLogger?.logEvent('agent.call.start', {
        run_id: options.runId,
        call_id: options.callId,
        mode: options.mode,
        provider: options.provider,
        model: options.model,
        prompt: options.prompt,
        system_prompt: options.systemPrompt,
        full_instructions: options.fullInstructions,
        input_message_count: options.inputMessageCount,
        continuation_message_count: options.continuationMessageCount,
        is_continuation: options.continuationMessageCount > 0,
      });
    },
    onCallFinish: event => {
      options.sessionLogger?.logEvent('agent.call.finish', {
        run_id: options.runId,
        call_id: options.callId,
        mode: options.mode,
        success: event.success,
        duration_ms: event.durationMs,
        ...(event.success
          ? {
              response_message_count: event.responseMessageCount ?? 0,
              pending_approval_count: event.pendingApprovalCount ?? 0,
              text: event.text ?? '',
            }
          : {
              error: serializeError(event.error),
            }),
      });
    },
  };
}

export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const runtime: ToolRuntime = {
    root_dir: options.runtime.cwd,
    allow_outside_cwd: options.runtime.allow_outside_cwd,
    bash_timeout_ms: options.runtime.bash_timeout_ms,
    bash_output_limit_bytes: options.runtime.bash_output_limit_bytes,
    raw_bash_output: options.runtime.agent.raw_bash_output,
    confirm_mutations:
      options.runtime.require_confirm_mutations &&
      !options.runtime.always_execute &&
      !options.runtime.dry_run,
    dry_run: options.runtime.dry_run,
    mutation_plan: [],
    debug: options.runtime.debug,
    log_debug: options.logDebug,
    log_tool_command: options.logToolCommand,
  };

  const tools = createToolSet(runtime);
  const promptSystemRaw = await buildSystemPrompt({
    cwd: options.runtime.cwd,
    global_system_path: options.global_system_path,
    local_system_path: options.local_system_path,
    prompt_files: options.runtime.agent.prompt_files,
    ignore_agents_md: options.runtime.agent.ignore_agents_md,
  });
  const promptSystem = promptSystemRaw.trim() ? promptSystemRaw : null;

  const baseInstructions = buildBaseInstructions(options.runtime.agent.raw_bash_output);
  const fullInstructions = promptSystem
    ? `${baseInstructions}\n\n${promptSystem}`
    : baseInstructions;
  const prompt = buildPrompt(options);
  const continuationMessageCount = options.messages?.length ?? 0;
  const inputMessages = buildInputMessages(prompt, options.messages);
  const runId = randomUUID();
  const startedAt = Date.now();
  const callId = randomUUID();
  const callbacks = createToolCallSessionCallbacks({
    runId,
    prompt,
    sessionLogger: options.sessionLogger,
  });
  const callLogger = createAgentCallSessionLogger({
    runId,
    callId,
    mode: 'execute',
    provider: options.runtime.agent.provider,
    model: options.runtime.agent.model,
    prompt,
    systemPrompt: promptSystem,
    fullInstructions,
    continuationMessageCount,
    inputMessageCount: inputMessages.length,
    sessionLogger: options.sessionLogger,
  });

  options.sessionLogger?.logEvent(
    'agent.run.start',
    buildAgentRunStartPayload({
      runId,
      instruction: options.instruction,
      prompt,
      cwd: options.runtime.cwd,
      maxSteps: options.runtime.max_steps,
      systemPrompt: promptSystem,
      fullInstructions,
      continuationMessageCount,
    }),
  );

  let callStarted = false;
  let callStartedAt = startedAt;

  try {
    const executeAgent = new ToolLoopAgent({
      model: createProviderModel(options),
      instructions: fullInstructions,
      tools,
      stopWhen: [
        stepCountIs(options.runtime.max_steps),
        stopOnTerminalBash,
      ],
      experimental_onToolCallStart: callbacks.onToolCallStart,
      experimental_onToolCallFinish: callbacks.onToolCallFinish,
    });
    callStartedAt = Date.now();
    callStarted = true;
    callLogger.onCallStart();

    const result = await executeAgent.generate({
      messages: inputMessages,
    });
    const terminalBashAnswer = extractTerminalBashAnswer(result.toolResults);

    const finalResult = mapExecuteResult(
      runtime.mutation_plan,
      terminalBashAnswer?.text ?? result.text,
      extractPendingApprovals(result.content as unknown[]),
      result.response.messages as ModelMessage[],
      terminalBashAnswer?.terminal,
    );
    callLogger.onCallFinish({
      success: true,
      durationMs: Math.max(0, Date.now() - callStartedAt),
      responseMessageCount: finalResult.responseMessages.length,
      pendingApprovalCount: finalResult.pendingApprovals.length,
      text: finalResult.text,
    });

    options.sessionLogger?.logEvent('agent.run.finish', {
      run_id: runId,
      mode: 'execute',
      duration_ms: Math.max(0, Date.now() - startedAt),
      success: true,
      mutation_plan_length: finalResult.mutationPlan.length,
      text: finalResult.text,
      pending_approval_count: finalResult.pendingApprovals.length,
    });

    return finalResult;
  } catch (error) {
    if (callStarted) {
      callLogger.onCallFinish({
        success: false,
        durationMs: Math.max(0, Date.now() - callStartedAt),
        error,
      });
    }
    options.sessionLogger?.logEvent('agent.run.finish', {
      run_id: runId,
      mode: 'execute',
      duration_ms: Math.max(0, Date.now() - startedAt),
      success: false,
      error: serializeError(error),
    });
    throw error;
  }
}
