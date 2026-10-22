import { createInterface } from 'node:readline/promises';
import { createColors } from 'picocolors';
import { truncateForPreview } from './policy.ts';
import type { PendingToolApproval } from './types.ts';

export type ConfirmationDecision =
  | { kind: 'approve' }
  | { kind: 'approve_all' }
  | { kind: 'decline' }
  | { kind: 'guidance'; text: string };

export function canPromptForConfirmation(): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

function getColors() {
  return createColors(Boolean(process.stderr.isTTY));
}

export function parseConfirmationInput(answer: string): ConfirmationDecision {
  const trimmed = answer.trim();
  if (/^y(es)?$/i.test(trimmed)) {
    return { kind: 'approve' };
  }

  if (/^a(ll)?$/i.test(trimmed)) {
    return { kind: 'approve_all' };
  }

  if (trimmed.length === 0 || /^n(o)?$/i.test(trimmed)) {
    return { kind: 'decline' };
  }

  return {
    kind: 'guidance',
    text: trimmed,
  };
}

function summarizePendingApproval(approval: PendingToolApproval): string {
  const input =
    typeof approval.input === 'object' && approval.input !== null
      ? (approval.input as Record<string, unknown>)
      : undefined;

  if (approval.toolName === 'Bash') {
    const command = typeof input?.command === 'string' ? input.command : '<unknown command>';
    return truncateForPreview(command, 180);
  }

  if (approval.toolName === 'Write') {
    const targetPath = typeof input?.path === 'string' ? input.path : '<unknown path>';
    const contentLength = typeof input?.content === 'string' ? input.content.length : null;
    if (contentLength === null) {
      return targetPath;
    }

    return `${targetPath} (${contentLength} chars)`;
  }

  if (approval.toolName === 'Edit') {
    const targetPath = typeof input?.path === 'string' ? input.path : '<unknown path>';
    const edits = Array.isArray(input?.edits) ? input.edits.length : null;
    if (edits === null) {
      return targetPath;
    }

    return `${targetPath} (${edits} edit block(s))`;
  }

  const fallback = JSON.stringify(approval.input);
  return truncateForPreview(fallback ?? '<unknown input>', 180);
}

export async function confirmPendingMutation(
  approval: PendingToolApproval,
  index: number,
  total: number,
): Promise<ConfirmationDecision> {
  // process.stdin is read here, not imported at the top: creating the stream
  // at startup empties stdin redirected from a file (`cook "…" < file`).
  const rl = createInterface({ input: process.stdin, output: process.stderr });

  try {
    const c = getColors();
    const cookTag = c.dim('[cook]');
    const toolTag = c.dim(`[${approval.toolName.toLowerCase()}]`);
    const decisionTag = c.dim('[y/N/a]');
    const summary = summarizePendingApproval(approval);

    if (total === 1) {
      process.stderr.write(`\n${cookTag} Mutating action\n`);
    } else {
      process.stderr.write(`\n${cookTag} Mutating action ${index}/${total}\n`);
    }
    process.stderr.write(`${cookTag} ${toolTag} ${summary}\n`);

    // ctrl+c reaches readline as a key, not a signal; without a listener
    // readline closes and the question never settles.
    const interrupted = new AbortController();
    rl.once('SIGINT', () => interrupted.abort());
    try {
      const answer = await rl.question(
        `${cookTag} Proceed? ${decisionTag} or tell cook what to do: `,
        { signal: interrupted.signal },
      );
      return parseConfirmationInput(answer);
    } catch (error) {
      if (!interrupted.signal.aborted) {
        throw error;
      }
      process.stderr.write('\n');
      return { kind: 'decline' };
    }
  } finally {
    rl.close();
  }
}
