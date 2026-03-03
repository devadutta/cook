import type { ConfirmationDecision } from './confirm.ts';
import type { PendingToolApproval, SessionLogger } from './types.ts';

export function logConfirmationDecision(
  logger: SessionLogger | undefined,
  approval: PendingToolApproval,
  decision: ConfirmationDecision,
): void {
  logger?.logEvent('confirmation.decision', {
    decision: decision.kind,
    guidance: decision.kind === 'guidance' ? decision.text : undefined,
    approval_id: approval.approvalId,
    tool_call_id: approval.toolCallId,
    tool_name: approval.toolName,
    input: approval.input,
  });
}
