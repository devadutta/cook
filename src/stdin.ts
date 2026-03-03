import { unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { StdinContext } from './types.ts';

function decodeUtf8(buffer: Buffer): { isText: boolean; text: string } {
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    return { isText: true, text: decoder.decode(buffer) };
  } catch {
    return { isText: false, text: '' };
  }
}

function toPreview(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }

  return normalized.length > 300
    ? `${normalized.slice(0, 300)}...`
    : normalized;
}

async function readAllStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    if (typeof chunk === 'string') {
      chunks.push(Buffer.from(chunk));
    } else {
      chunks.push(Buffer.from(chunk));
    }
  }

  return Buffer.concat(chunks);
}

export async function readStdinContext(
  inlineLimitBytes: number,
): Promise<StdinContext> {
  if (process.stdin.isTTY) {
    return {
      mode: 'none',
      bytes: 0,
      isText: true,
      preview: '',
    };
  }

  const buffer = await readAllStdin();
  const bytes = buffer.byteLength;
  const decoded = decodeUtf8(buffer);

  if (decoded.isText && bytes <= inlineLimitBytes) {
    return {
      mode: 'inline',
      bytes,
      isText: true,
      preview: toPreview(decoded.text),
      inlineText: decoded.text,
    };
  }

  const ext = decoded.isText ? 'txt' : 'bin';
  const filePath = path.join(os.tmpdir(), `cook-stdin-${randomUUID()}.${ext}`);
  await Bun.write(filePath, buffer);

  const preview = decoded.isText ? toPreview(decoded.text) : '<binary stdin>';

  return {
    mode: 'temp-file',
    bytes,
    isText: decoded.isText,
    preview,
    tempFilePath: filePath,
    cleanup: async () => {
      try {
        await unlink(filePath);
      } catch {
        // Ignore cleanup errors.
      }
    },
  };
}
