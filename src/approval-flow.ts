import type { ModelMessage, ToolApprovalResponse } from '@ai-sdk/provider-utils';
import type { ConfirmationDecision } from './confirm.ts';
import { EXIT_CODES } from './defaults.ts';
import { truncateForPreview } from './policy.ts';
import type { AgentRunResult, MutationRecord, PendingToolApproval } from './types.ts';

export interface ApprovalFlowOptions {
  runAgent: (options: { messages?: ModelMessage[] }) => Promise<AgentRunResult>;
  confirmApproval: (
    approval: PendingToolApproval,
    index: number,
    total: number,
  ) => Promise<ConfirmationDecision>;
  printStdout: (message: string) => void;
  printStderr: (message: string) => void;
  canPromptForConfirmation: () => boolean;
  onConfirmationDecision?: (
    approval: PendingToolApproval,
    decision: ConfirmationDecision,
  ) => void;
}

function appendMutations(
  target: MutationRecord[],
  next: MutationRecord[],
): MutationRecord[] {
  target.push(...next);
  return target;
}

function buildApprovalResponse(
  approvalId: string,
  approved: boolean,
  reason?: string,
): ToolApprovalResponse {
  return {
    type: 'tool-approval-response',
    approvalId,
    approved,
    reason,
  };
}

function summarizeApprovalForGuidance(approval: PendingToolApproval): string {
  const input =
    typeof approval.input === 'object' && approval.input !== null
      ? (approval.input as Record<string, unknown>)
      : undefined;

  if (approval.toolName === 'Bash') {
    const command =
      typeof input?.command === 'string' ? input.command : '<unknown command>';
    return `Bash: ${truncateForPreview(command, 140)}`;
  }

  if (approval.toolName === 'Write') {
    const targetPath =
      typeof input?.path === 'string' ? input.path : '<unknown path>';
    const contentLength =
      typeof input?.content === 'string' ? input.content.length : null;
    if (contentLength === null) {
      return `Write: ${targetPath}`;
    }

    return `Write: ${targetPath} (${contentLength} chars)`;
  }

  if (approval.toolName === 'Edit') {
    const targetPath =
      typeof input?.path === 'string' ? input.path : '<unknown path>';
    const edits = Array.isArray(input?.edits) ? input.edits.length : null;
    if (edits === null) {
      return `Edit: ${targetPath}`;
    }

    return `Edit: ${targetPath} (${edits} edit block(s))`;
  }

  let fallback = '<unknown input>';
  try {
    const serialized = JSON.stringify(approval.input);
    if (serialized) {
      fallback = serialized;
    }
  } catch {
    // ignore serialization errors; keep fallback
  }

  return `${approval.toolName}: ${truncateForPreview(fallback, 140)}`;
}

function buildGuidanceContinuationMessage(
  guidance: string,
  deniedApprovals: PendingToolApproval[],
): string {
  const baseMessage =
    `User correction from confirmation prompt: "${guidance}". ` +
    'This applies for the rest of this run. ' +
    'Do not repeat denied mutating actions unchanged; revise your next proposal accordingly.';

  if (deniedApprovals.length === 0) {
    return baseMessage;
  }

  const deniedSummary = deniedApprovals
    .map((approval, index) => `${index + 1}. ${summarizeApprovalForGuidance(approval)}`)
    .join(' ');
  return `${baseMessage} Denied actions: ${deniedSummary}`;
}

export interface ApprovalFlowResult {
  exitCode: number;
  mutationPlan: MutationRecord[];
}

export async function runApprovalFlow(
  options: ApprovalFlowOptions,
): Promise<ApprovalFlowResult> {
  const conversation: ModelMessage[] = [];
  const mutationPlan: MutationRecord[] = [];
  let approveAll = false;

  while (true) {
    const run = await options.runAgent({
      messages: conversation.length > 0 ? conversation : undefined,
    });

    appendMutations(mutationPlan, run.mutationPlan);
    conversation.push(...run.responseMessages);

    if (run.pendingApprovals.length === 0) {
      if (run.text) {
        options.printStdout(run.text);
      }

      return {
        exitCode: EXIT_CODES.SUCCESS,
        mutationPlan,
      };
    }

    if (!approveAll && !options.canPromptForConfirmation()) {
      options.printStderr(
        'Mutating actions require confirmation but no interactive TTY is available. Re-run with --yes or --dry-run.',
      );
      return {
        exitCode: EXIT_CODES.NON_TTY_CONFIRMATION_REQUIRED,
        mutationPlan,
      };
    }

    const responses: ToolApprovalResponse[] = [];
    let guidanceMessage: string | null = null;

    for (let index = 0; index < run.pendingApprovals.length; index += 1) {
      const approval = run.pendingApprovals[index]!;

      if (approveAll) {
        const decision: ConfirmationDecision = { kind: 'approve_all' };
        options.onConfirmationDecision?.(approval, decision);
        responses.push(buildApprovalResponse(approval.approvalId, true));
        continue;
      }

      const decision = await options.confirmApproval(
        approval,
        index + 1,
        run.pendingApprovals.length,
      );

      if (decision.kind === 'decline') {
        options.onConfirmationDecision?.(approval, decision);
        options.printStderr('Aborted by user.');
        return {
          exitCode: EXIT_CODES.DECLINED,
          mutationPlan,
        };
      }

      if (decision.kind === 'approve') {
        options.onConfirmationDecision?.(approval, decision);
        responses.push(buildApprovalResponse(approval.approvalId, true));
        continue;
      }

      if (decision.kind === 'approve_all') {
        options.onConfirmationDecision?.(approval, decision);
        approveAll = true;
        responses.push(buildApprovalResponse(approval.approvalId, true));

        for (let rest = index + 1; rest < run.pendingApprovals.length; rest += 1) {
          const remaining = run.pendingApprovals[rest]!;
          const remainingDecision: ConfirmationDecision = { kind: 'approve_all' };
          options.onConfirmationDecision?.(remaining, remainingDecision);
          responses.push(buildApprovalResponse(remaining.approvalId, true));
        }

        break;
      }

      const deniedApprovals = run.pendingApprovals.slice(index);
      for (let rest = index; rest < run.pendingApprovals.length; rest += 1) {
        const remaining = run.pendingApprovals[rest]!;
        options.onConfirmationDecision?.(remaining, decision);
        responses.push(
          buildApprovalResponse(remaining.approvalId, false, decision.text),
        );
      }
      guidanceMessage = buildGuidanceContinuationMessage(
        decision.text,
        deniedApprovals,
      );

      break;
    }

    conversation.push({
      role: 'tool',
      content: responses,
    });
    if (guidanceMessage !== null) {
      conversation.push({
        role: 'user',
        content: guidanceMessage,
      });
    }
  }
}
