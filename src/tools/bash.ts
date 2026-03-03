import { exec, type ExecException } from 'node:child_process';
import { promisify } from 'node:util';
import { tool } from 'ai';
import { z } from 'zod';
import { resolveBashCwd, truncateForPreview } from '../policy.ts';
import type { BashMutationInput, ToolRuntime } from '../types.ts';

const execAsync = promisify(exec);

const inputSchema = z.object({
  command: z.string().min(1),
  isMutating: z.boolean(),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().min(100).max(3_600_000).optional(),
  isFinal: z.boolean().optional(),
});

function pushMutation(
  runtime: ToolRuntime,
  summary: string,
  input: BashMutationInput,
): void {
  runtime.mutation_plan.push({
    tool: 'Bash',
    summary,
    input,
  });
}

function asString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Buffer.isBuffer(value)) {
    return value.toString('utf8');
  }

  return '';
}

export function createBashTool(runtime: ToolRuntime) {
  const descriptionBase =
    'Run a shell command via bash. Use for filesystem queries, transforms, and command-line utilities. Include isMutating in every call: set true only for task-impacting state changes, and false for read-only or ephemeral scratch effects (for example redirecting to /dev/null or temporary files).';
  const description = runtime.raw_bash_output
    ? `${descriptionBase} Set isFinal=true only when command output should be returned directly as the final answer.`
    : descriptionBase;

  return tool({
    description,
    inputSchema,
    needsApproval: input => runtime.confirm_mutations && input.isMutating,
    execute: async ({ command, isMutating, cwd, timeoutMs, isFinal }) => {
      const resolvedCwd = resolveBashCwd(
        runtime.root_dir,
        cwd,
        runtime.allow_outside_cwd,
      );

      const effectiveIsFinal = runtime.raw_bash_output && isFinal === true;
      const summary = truncateForPreview(command, 180);
      runtime.log_tool_command(
        'Bash',
        `${command} (cwd=${resolvedCwd}, isMutating=${isMutating})`,
      );

      if (isMutating) {
        pushMutation(runtime, summary, {
          command,
          cwd: resolvedCwd,
          timeoutMs,
        });
      }

      if (runtime.dry_run && isMutating) {
        return {
          ok: true,
          planned: true,
          mutating: true,
          command,
          cwd: resolvedCwd,
          isFinal: effectiveIsFinal,
        };
      }

      const effectiveTimeout = timeoutMs ?? runtime.bash_timeout_ms;

      try {
        const result = await execAsync(command, {
          cwd: resolvedCwd,
          timeout: effectiveTimeout,
          maxBuffer: runtime.bash_output_limit_bytes,
          shell: '/bin/bash',
          windowsHide: true,
          encoding: 'utf8',
        });

        return {
          ok: true,
          planned: false,
          mutating: isMutating,
          command,
          cwd: resolvedCwd,
          isFinal: effectiveIsFinal,
          exitCode: 0,
          stdout: asString(result.stdout),
          stderr: asString(result.stderr),
          timedOut: false,
          outputTruncated: false,
        };
      } catch (error) {
        const execError = error as ExecException & {
          stdout?: string | Buffer;
          stderr?: string | Buffer;
          code?: number | string;
          signal?: NodeJS.Signals;
        };

        const timedOut = Boolean(execError.killed && execError.signal === 'SIGTERM');
        const outputTruncated = /maxbuffer/i.test(execError.message);

        return {
          ok: true,
          planned: false,
          mutating: isMutating,
          command,
          cwd: resolvedCwd,
          isFinal: effectiveIsFinal,
          exitCode: typeof execError.code === 'number' ? execError.code : null,
          stdout: asString(execError.stdout),
          stderr: asString(execError.stderr),
          timedOut,
          outputTruncated,
          error: execError.message,
        };
      }
    },
  });
}
