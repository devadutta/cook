#!/usr/bin/env bun

import { runApprovalFlow } from './approval-flow.ts';
import { runAgent } from './agent.ts';
import { applyConfiguredApiKeys } from './auth.ts';
import { parseCli } from './cli-parse.ts';
import { loadConfig } from './config.ts';
import { runConfigInitCommand } from './config-init.ts';
import {
  isBuiltInDefaultAgent,
  resolvePortableDefaultProvider,
} from './portable-default.ts';
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
import type {
  CookConfig,
  ResolvedAgentConfig,
  RuntimeConfig,
  SessionLogger,
} from './types.ts';
import type { CliFlags } from './cli-parse.ts';

export function rewriteKnownErrorMessage(message: string): string {
  const isGatewayUnauthenticatedError =
    message.includes('Unauthenticated request to AI Gateway') ||
    message.includes('ai-sdk.dev/unauthenticated-ai-gateway');

  if (!isGatewayUnauthenticatedError) {
    return message;
  }

  return [
    'Set one of these API keys in env, or run `cook config init`:',
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

function resolveAgentName(config: CookConfig, flags: CliFlags): string {
  if (flags.agent) {
    if (!(flags.agent in config.agents)) {
      const available = Object.keys(config.agents).join(', ');
      throw new CliError(`Unknown agent "${flags.agent}". Available agents: ${available}`);
    }

    return flags.agent;
  }

  if (config.default_agent) {
    if (!(config.default_agent in config.agents)) {
      throw new CliError(
        `default_agent "${config.default_agent}" is not defined in agents.`,
      );
    }

    return config.default_agent;
  }

  if ('default' in config.agents) {
    return 'default';
  }

  throw new CliError(
    'No agent selected. Set default_agent in config or pass --agent <name>.',
  );
}

function resolveRuntimeAgent(
  config: CookConfig,
  agentName: string,
  flags: CliFlags,
): ResolvedAgentConfig {
  const baseAgent = config.agents[agentName];
  if (!baseAgent) {
    throw new CliError(`Resolved agent "${agentName}" is missing from configuration.`);
  }

  let resolvedAgent = baseAgent;
  if (isBuiltInDefaultAgent(agentName, baseAgent)) {
    const portableProvider = resolvePortableDefaultProvider(config, process.env);
    if (portableProvider) {
      resolvedAgent = {
        ...baseAgent,
        provider: portableProvider.provider,
        model: portableProvider.model,
      };
    }
  }

  return {
    ...resolvedAgent,
    raw_bash_output: Boolean(flags.raw || resolvedAgent.raw_bash_output),
  };
}

export function createRuntimeConfig(config: CookConfig, flags: CliFlags): RuntimeConfig {
  const agent_name = resolveAgentName(config, flags);
  const agent = resolveRuntimeAgent(config, agent_name, flags);

  const {
    agents: _agents,
    default_agent: _default_agent,
    ...base
  } = config;

  return {
    ...base,
    agent_name,
    agent,
    cwd: process.cwd(),
    always_execute: Boolean(flags.yes),
    dry_run: Boolean(flags.dryRun),
  };
}

async function run(): Promise<number> {
  const rawArgs = process.argv.slice(2);
  if (rawArgs[0] === 'config' && rawArgs[1] === 'init') {
    return runConfigInitCommand(rawArgs.slice(2));
  }

  const { instruction: parsedInstruction, flags } = parseCli(process.argv);
  const resolvedInstruction = await resolveCommandInstruction({
    instruction: parsedInstruction,
    cwd: process.cwd(),
  });
  const instruction = resolvedInstruction.instruction;
  const { config, global_system_path, local_system_path } = await loadConfig(
    { cwd: process.cwd() },
    toConfigOverrides(flags),
  );
  const runtime = createRuntimeConfig(config, flags);
  const logDebug = createDebugLogger(runtime.debug);
  const logToolCommand = createToolCommandLogger(!runtime.quiet);
  applyConfiguredApiKeys(runtime, logDebug);
  let sessionLogger: SessionLogger | undefined;
  if (runtime.session_logs) {
    sessionLogger = await createSessionLogger({
      cwd: runtime.cwd,
      argv: process.argv.slice(2),
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
      return exitCode;
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
            messages,
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
      return exitCode;
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
    });

    if (result.text) {
      printStdout(result.text);
    }

    exitCode = EXIT_CODES.SUCCESS;
    return exitCode;
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
