import { describe, expect, it } from 'bun:test';
import { createBashTool } from '../src/tools/bash.ts';
import type { ToolRuntime } from '../src/types.ts';

interface BashToolLike {
  execute: (input: {
    command: string;
    isMutating: boolean;
    isFinal?: boolean;
  }) => Promise<{
    planned: boolean;
    mutating: boolean;
    isFinal: boolean;
    exitCode: number | null;
    stdout: string;
  }>;
}

function createRuntime(
  rawBashOutput: boolean,
  options?: { dryRun?: boolean },
): ToolRuntime {
  return {
    root_dir: process.cwd(),
    allow_outside_cwd: true,
    bash_timeout_ms: 5_000,
    bash_output_limit_bytes: 1024 * 1024,
    raw_bash_output: rawBashOutput,
    confirm_mutations: false,
    dry_run: options?.dryRun ?? false,
    mutation_plan: [],
    debug: false,
    log_debug: () => {},
    log_tool_command: () => {},
  };
}

describe('createBashTool', () => {
  it('ignores isFinal when raw_bash_output is disabled', async () => {
    const bash = createBashTool(createRuntime(false)) as unknown as BashToolLike;
    const result = await bash.execute({
      command: "printf 'ok\\n'",
      isMutating: false,
      isFinal: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ok\n');
    expect(result.isFinal).toBe(false);
  });

  it('preserves isFinal when raw_bash_output is enabled', async () => {
    const bash = createBashTool(createRuntime(true)) as unknown as BashToolLike;
    const result = await bash.execute({
      command: "printf 'ok\\n'",
      isMutating: false,
      isFinal: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ok\n');
    expect(result.isFinal).toBe(true);
  });

  it('treats regex-looking command as non-mutating when isMutating=false', async () => {
    const runtime = createRuntime(false);
    const bash = createBashTool(runtime) as unknown as BashToolLike;
    const result = await bash.execute({
      command: 'echo hi > /dev/null',
      isMutating: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.mutating).toBe(false);
    expect(runtime.mutation_plan).toHaveLength(0);
  });

  it('records mutation plan when isMutating=true', async () => {
    const runtime = createRuntime(false);
    const bash = createBashTool(runtime) as unknown as BashToolLike;
    const result = await bash.execute({
      command: "printf 'ok\\n'",
      isMutating: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.mutating).toBe(true);
    expect(runtime.mutation_plan).toHaveLength(1);
    expect(runtime.mutation_plan[0]?.tool).toBe('Bash');
  });

  it('dry-run plans only when isMutating=true', async () => {
    const mutatingRuntime = createRuntime(false, { dryRun: true });
    const mutatingBash = createBashTool(mutatingRuntime) as unknown as BashToolLike;
    const mutatingResult = await mutatingBash.execute({
      command: "printf 'ok\\n'",
      isMutating: true,
    });

    expect(mutatingResult.planned).toBe(true);
    expect(mutatingResult.mutating).toBe(true);
    expect(mutatingRuntime.mutation_plan).toHaveLength(1);

    const nonMutatingRuntime = createRuntime(false, { dryRun: true });
    const nonMutatingBash = createBashTool(nonMutatingRuntime) as unknown as BashToolLike;
    const nonMutatingResult = await nonMutatingBash.execute({
      command: "printf 'ok\\n'",
      isMutating: false,
    });

    expect(nonMutatingResult.planned).toBe(false);
    expect(nonMutatingResult.mutating).toBe(false);
    expect(nonMutatingResult.exitCode).toBe(0);
    expect(nonMutatingRuntime.mutation_plan).toHaveLength(0);
  });
});
