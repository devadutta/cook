import { rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { resolveScopedPath } from '../policy.ts';
import type { EditMutationInput, ToolRuntime } from '../types.ts';

const editItemSchema = z.object({
  find: z.string().min(1),
  replace: z.string(),
});

const inputSchema = z.object({
  path: z.string().min(1),
  edits: z.array(editItemSchema).min(1),
  expectedCount: z.number().int().min(0).optional(),
});

export interface ApplyEditsResult {
  output: string;
  totalReplacements: number;
  replacementsPerEdit: number[];
}

function countOccurrences(haystack: string, needle: string): number {
  let from = 0;
  let count = 0;

  while (true) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) {
      break;
    }

    count += 1;
    from = index + needle.length;
  }

  return count;
}

export function applyFindReplaceEdits(
  source: string,
  edits: Array<{ find: string; replace: string }>,
  expectedCount?: number,
): ApplyEditsResult {
  let output = source;
  const replacementsPerEdit: number[] = [];
  let totalReplacements = 0;

  for (const edit of edits) {
    const count = countOccurrences(output, edit.find);
    if (count === 0) {
      throw new Error(`Edit failed: did not find \"${edit.find}\"`);
    }

    output = output.split(edit.find).join(edit.replace);
    replacementsPerEdit.push(count);
    totalReplacements += count;
  }

  if (expectedCount !== undefined && totalReplacements !== expectedCount) {
    throw new Error(
      `Edit failed: expected ${expectedCount} replacements, got ${totalReplacements}`,
    );
  }

  return {
    output,
    totalReplacements,
    replacementsPerEdit,
  };
}

function pushMutation(
  runtime: ToolRuntime,
  summary: string,
  input: EditMutationInput,
): void {
  runtime.mutation_plan.push({
    tool: 'Edit',
    summary,
    input,
  });
}

export function createEditTool(runtime: ToolRuntime) {
  return tool({
    description:
      'Apply exact find/replace edits to a file. All edits are applied atomically.',
    inputSchema,
    needsApproval: runtime.confirm_mutations,
    execute: async ({ path: targetPath, edits, expectedCount }) => {
      const resolved = resolveScopedPath(
        runtime.root_dir,
        targetPath,
        runtime.allow_outside_cwd,
      );
      runtime.log_debug(`Edit requested: ${resolved} (${edits.length} edit block(s))`);
      pushMutation(runtime, `${resolved} (${edits.length} edit block(s))`, {
        path: resolved,
        edits,
        expectedCount,
      });

      if (runtime.dry_run) {
        return {
          ok: true,
          planned: true,
          path: resolved,
        };
      }

      const file = Bun.file(resolved);
      if (!(await file.exists())) {
        throw new Error(`Edit failed: file not found: ${resolved}`);
      }

      const original = await file.text();
      const result = applyFindReplaceEdits(original, edits, expectedCount);

      const tempPath = path.join(
        path.dirname(resolved),
        `.cook-edit-${randomUUID()}.tmp`,
      );
      await Bun.write(tempPath, result.output);
      await rename(tempPath, resolved);

      return {
        ok: true,
        planned: false,
        path: resolved,
        totalReplacements: result.totalReplacements,
      };
    },
  });
}
