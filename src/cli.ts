#!/usr/bin/env bun

import { runApprovalFlow } from './approval-flow.ts';
import { runAgent } from './agent.ts';
import { applyConfiguredApiKeys } from './auth.ts';
import { parseCli } from './cli-parse.ts';
import { loadConfig } from './config.ts';
import { runConfigInitCommand } from './config-init.ts';
import { runLoginCommand, runLogoutCommand } from './login.ts';
import { hasOpenAICodexCredentials } from './openai-oauth.ts';
import { createRuntimeConfig } from './runtime-config.ts';
import {
  canPromptForConfirmation,
  confirmPendingMutation,
} from './confirm.ts';
import { resolveCommandInstruction } from './command-instruction.ts';
import { EXIT_CODES } from './defaults.ts';
import { CliError } from './errors.ts';
import {
  createDebugLogger,
  createToolCommandLogger,
  printAgentLoaded,
  printMutationPlan,
  printStderr,
  printStdout,
} from './output.ts';
import { logConfirmationDecision } from './session-log-events.ts';
import { createSessionLogger, serializeSessionError } from './session-logger.ts';
import { readStdinContext } from './stdin.ts';
import { tuiHost } from './tui/host.ts';
import type { CookConfig, SessionLogger } from './types.ts';
import type { CliFlags } from './cli-parse.ts';
import type { ModelMessage } from '@ai-sdk/provider-utils';

export { createRuntimeConfig };

export function rewriteKnownErrorMessage(message: string): string {
  const isGatewayUnauthenticatedError =
    message.includes('Unauthenticated request to AI Gateway') ||
    message.includes('ai-sdk.dev/unauthenticated-ai-gateway');

  if (!isGatewayUnauthenticatedError) {
    return message;
  }

  return [
    'Set one of these API keys in env, run `cook config init`, or run `cook login` to use your ChatGPT subscription:',
    '- AI_GATEWAY_API_KEY',
    '- OPENAI_API_KEY',
    '- ANTHROPIC_API_KEY',
    '- GOOGLE_GENERATIVE_AI_API_KEY',
    '- GROQ_API_KEY',
  ].join('\n');
}

function toConfigOverrides(flags: CliFlags): Partial<CookConfig> {
  return {
    max_steps: flags.maxSteps,
    bash_timeout_ms: flags.timeout,
    allow_outside_cwd: flags.allowOutsideCwd ? true : undefined,
    quiet: flags.quiet ? true : undefined,
    debug: flags.debug || flags.verbose ? true : undefined,
  };
}

export function shouldLaunchTui(
  args: string[],
  isInteractive: () => boolean = () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
): boolean {
  // Check args first: touching process.stdin creates the stream, which costs
  // startup time that `cook <instruction>` should not pay here.
  return args.length === 0 && isInteractive();
}

// import() through a parameter is resolved at runtime, so the bundler cannot
// inline the target. Compiled builds embed src/tui/app.ts and src/decision.ts
// as extra entrypoints instead (see package.json and scripts/release.sh), which
// keeps `cook <instruction>` from loading or even parsing their code.
function importAtRuntime<T>(specifier: string): Promise<T> {
  return import(specifier) as Promise<T>;
}

async function run(): Promise<number> {
  const rawArgs = process.argv.slice(2);
  if (shouldLaunchTui(rawArgs)) {
    const { runTui } = await importAtRuntime<typeof import('./tui/app.ts')>('./tui/app.js');
    await runTui({ cwd: process.cwd(), host: tuiHost, runTurn: runInteractiveTurn });
    return EXIT_CODES.SUCCESS;
  }
  if (rawArgs[0] === 'config' && rawArgs[1] === 'init') {
    return runConfigInitCommand(rawArgs.slice(2));
  }
  if (rawArgs[0] === 'login') {
    return runLoginCommand(rawArgs.slice(1));
  }
  if (rawArgs[0] === 'logout') {
    return runLogoutCommand(rawArgs.slice(1));
  }

  const { instruction, flags } = parseCli(process.argv);
  return (await runInstruction(instruction, flags, rawArgs)).exitCode;
}

/**
 * Runs one message of an interactive session and returns the conversation to
 * continue from. ctrl+c stops the message instead of quitting cook, and a
 * message that fails or is stopped leaves the conversation as it was.
 */
async function runInteractiveTurn(
  instruction: string,
  history: ModelMessage[],
): Promise<ModelMessage[]> {
  const controller = new AbortController();
  const interrupt = () => {
    // A tool that ignores ctrl+c keeps the turn running; a second press quits.
    if (controller.signal.aborted) {
      process.exit(EXIT_CODES.INTERRUPTED);
    }
    controller.abort();
  };
  process.on('SIGINT', interrupt);

  try {
    const { messages } = await runInstruction(instruction, {}, [instruction], {
      history,
      abortSignal: controller.signal,
    });
    if (!controller.signal.aborted) {
      return messages;
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      const message = error instanceof Error ? error.message : String(error);
      printStderr(`cook failed: ${rewriteKnownErrorMessage(message)}`);
      return history;
    }
  } finally {
    process.off('SIGINT', interrupt);
  }

  printStderr('\nInterrupted.'); // after the terminal's ^C
  return history;
}

interface Turn {
  history?: ModelMessage[];
  abortSignal?: AbortSignal;
}

interface InstructionResult {
  exitCode: number;
  /** The conversation to continue from in the next interactive turn. */
  messages: ModelMessage[];
}

async function runInstruction(
  parsedInstruction: string,
  flags: CliFlags,
  argv: string[],
  turn: Turn = {},
): Promise<InstructionResult> {
  const history = turn.history ?? [];
  const resolvedInstruction = await resolveCommandInstruction({
    instruction: parsedInstruction,
    cwd: process.cwd(),
  });
  const instruction = resolvedInstruction.instruction;
  const { config, global_system_path, local_system_path } = await loadConfig(
    { cwd: process.cwd() },
    toConfigOverrides(flags),
  );
  const openaiOAuth = await hasOpenAICodexCredentials();
  const runtime = createRuntimeConfig(config, flags, { openaiOAuth });
  const decision = runtime.agent.type === 'decision';
  if (!decision && !instruction) {
    throw new CliError('Missing instruction. Example: cook "find all .py files older than 2 months"');
  }
  if (flags.json && !decision) {
    throw new CliError(`--json only applies to decision agents; ${runtime.agent_name} runs tools.`);
  }
  const logDebug = createDebugLogger(runtime.debug);
  const logToolCommand = createToolCommandLogger(!runtime.quiet);
  applyConfiguredApiKeys(runtime, logDebug);
  let sessionLogger: SessionLogger | undefined;
  if (runtime.session_logs) {
    sessionLogger = await createSessionLogger({
      cwd: runtime.cwd,
      argv,
      agent_name: runtime.agent_name,
      provider: runtime.agent.provider,
      model: runtime.agent.model,
      onWarning: message => {
        printStderr(message);
        logDebug(message);
      },
    });
    logDebug(
      `session_logs enabled (session_id=${sessionLogger.session_id} dir=${sessionLogger.session_dir ?? '<disabled>'})`,
    );
  }

  if (!runtime.quiet) {
    printAgentLoaded(runtime.agent_name);
  }

  logDebug(
    `agent=${runtime.agent_name} provider=${runtime.agent.provider} model=${runtime.agent.model} max_steps=${runtime.max_steps} cwd=${runtime.cwd}`,
  );
  if (resolvedInstruction.sourcePath && resolvedInstruction.commandName) {
    logDebug(
      `resolved command /${resolvedInstruction.commandName} from ${resolvedInstruction.sourcePath}`,
    );
  }

  let stdin: Awaited<ReturnType<typeof readStdinContext>> | undefined;
  let exitCode: number = EXIT_CODES.FAILURE;
  let runError: string | undefined;

  try {
    const stdinContext = await readStdinContext(runtime.stdin_inline_max_bytes);
    stdin = stdinContext;
    logDebug(`stdin mode=${stdinContext.mode} bytes=${stdinContext.bytes}`);

    if (decision) {
      // One request to a decision model, no tool loop.
      const { runDecision } = await importAtRuntime<typeof import('./decision.ts')>('./decision.js');
      printStdout(await runDecision({
        instruction,
        runtime,
        stdin: stdinContext,
        json: Boolean(flags.json),
        logDebug,
        sessionLogger,
        abortSignal: turn.abortSignal,
      }));
      exitCode = EXIT_CODES.SUCCESS;
      return { exitCode, messages: history };
    }

    if (runtime.dry_run) {
      const preview = await runAgent({
        instruction,
        runtime,
        stdin: stdinContext,
        global_system_path,
        local_system_path,
        logDebug,
        logToolCommand,
        sessionLogger,
      });

      if (preview.mutationPlan.length > 0) {
        printMutationPlan(preview.mutationPlan, 'Dry-run planned mutating actions:');
      } else {
        printStderr('Dry-run found no mutating actions.');
      }

      if (preview.text) {
        printStdout(preview.text);
      }

      exitCode = EXIT_CODES.SUCCESS;
      return { exitCode, messages: history };
    }

    const confirmationRequired =
      runtime.require_confirm_mutations && !runtime.always_execute;

    if (confirmationRequired) {
      const flow = await runApprovalFlow({
        runAgent: ({ messages }) =>
          runAgent({
            instruction,
            runtime,
            stdin: stdinContext,
            global_system_path,
            local_system_path,
            logDebug,
            logToolCommand,
            sessionLogger,
            history,
            messages,
            abortSignal: turn.abortSignal,
          }),
        confirmApproval: confirmPendingMutation,
        printStdout,
        printStderr,
        canPromptForConfirmation,
        onConfirmationDecision: (approval, decision) => {
          logConfirmationDecision(sessionLogger, approval, decision);
        },
      });
      exitCode = flow.exitCode;
      return { exitCode, messages: flow.messages };
    }

    const result = await runAgent({
      instruction,
      runtime,
      stdin: stdinContext,
      global_system_path,
      local_system_path,
      logDebug,
      logToolCommand,
      sessionLogger,
      history,
      abortSignal: turn.abortSignal,
    });

    if (result.text) {
      printStdout(result.text);
    }

    exitCode = EXIT_CODES.SUCCESS;
    return { exitCode, messages: result.messages };
  } catch (error) {
    runError = error instanceof Error ? error.message : String(error);
    sessionLogger?.logEvent('session.error', {
      error: serializeSessionError(error),
    });
    throw error;
  } finally {
    await stdin?.cleanup?.();
    await sessionLogger?.finish(
      exitCode === EXIT_CODES.SUCCESS ? 'success' : 'failure',
      {
        exit_code: exitCode,
        error: runError,
      },
    );
  }
}

async function main(): Promise<void> {
  try {
    const exitCode = await run();
    process.exit(exitCode);
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = rewriteKnownErrorMessage(rawMessage);
    const stack = error instanceof Error ? error.stack : undefined;
    const exitCode = error instanceof CliError ? error.exitCode : EXIT_CODES.FAILURE;
    const debugRequested = process.argv.includes('--debug') || process.argv.includes('--verbose');

    printStderr(`cook failed: ${message}`);
    if (stack && debugRequested) {
      printStderr(stack);
    }

    process.exit(exitCode);
  }
}

if (import.meta.main) {
  void main();
}
