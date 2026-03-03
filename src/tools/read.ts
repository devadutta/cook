import { tool } from 'ai';
import { z } from 'zod';
import { resolveScopedPath } from '../policy.ts';
import type { ToolRuntime } from '../types.ts';

const inputSchema = z.object({
  path: z.string().min(1),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(2_000_000).optional(),
});

function decodeUtf8(buffer: Buffer): { isText: boolean; text: string } {
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    return { isText: true, text: decoder.decode(buffer) };
  } catch {
    return { isText: false, text: '' };
  }
}

export function createReadTool(runtime: ToolRuntime) {
  return tool({
    description:
      'Read a file from disk. Use this for inspecting file contents before editing or shell operations.',
    inputSchema,
    execute: async ({ path, offset = 0, limit = 100_000 }) => {
      const resolved = resolveScopedPath(
        runtime.root_dir,
        path,
        runtime.allow_outside_cwd,
      );
      runtime.log_tool_command(
        'Read',
        `${resolved} (offset=${offset}, limit=${limit})`,
      );

      const file = Bun.file(resolved);
      if (!(await file.exists())) {
        return {
          ok: false,
          path: resolved,
          error: 'File not found',
        };
      }

      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const decoded = decodeUtf8(buffer);

      if (!decoded.isText) {
        return {
          ok: true,
          path: resolved,
          isText: false,
          byteLength: buffer.byteLength,
          contentBase64: buffer.toString('base64'),
        };
      }

      const sliced = decoded.text.slice(offset, offset + limit);

      return {
        ok: true,
        path: resolved,
        isText: true,
        byteLength: buffer.byteLength,
        offset,
        limit,
        truncated: offset + limit < decoded.text.length,
        content: sliced,
      };
    },
  });
}
