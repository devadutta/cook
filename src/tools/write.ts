import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { resolveScopedPath } from '../policy.ts';
import type { ToolRuntime, WriteMutationInput } from '../types.ts';

const inputSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  createDirs: z.boolean().optional(),
});

function pushMutation(
  runtime: ToolRuntime,
  summary: string,
  input: WriteMutationInput,
): void {
  runtime.mutation_plan.push({
    tool: 'Write',
    summary,
    input,
  });
}

export function createWriteTool(runtime: ToolRuntime) {
  return tool({
    description: 'Write full file contents to disk. Creates or overwrites files.',
    inputSchema,
    needsApproval: runtime.confirm_mutations,
    execute: async ({ path: targetPath, content, createDirs = false }) => {
      const resolved = resolveScopedPath(
        runtime.root_dir,
        targetPath,
        runtime.allow_outside_cwd,
      );

      const summary = `${resolved} (${content.length} chars)`;
      runtime.log_tool_command(
        'Write',
        `${resolved} (${content.length} chars, createDirs=${createDirs})`,
      );
      pushMutation(runtime, summary, {
        path: resolved,
        content,
        createDirs,
      });

      if (runtime.dry_run) {
        return {
          ok: true,
          planned: true,
          path: resolved,
        };
      }

      if (createDirs) {
        await mkdir(path.dirname(resolved), { recursive: true });
      }

      await Bun.write(resolved, content);

      return {
        ok: true,
        planned: false,
        path: resolved,
        bytesWritten: Buffer.byteLength(content),
      };
    },
  });
}
