// The approval grammar a WhatsApp sender may use (ADR-0017 decision 7). A matching text is a
// decision, not a message: it is never posted to the thread. The verb list is deliberately short
// and the id must look like one the Gateway hands out, so ordinary chat ("yes please", "no
// thanks", "approve this") stays chat. `allow_always` has no spelling here on purpose.

import type { ApprovalDecision } from "@deskmates/contracts";

export interface ApprovalCommand {
  decision: Extract<ApprovalDecision, "allow_once" | "deny">;
  approvalId: string;
  reason?: string;
}

const COMMAND = /^\s*(approve|allow|deny|reject)\s+(\S+)(?:\s+([\s\S]+?))?\s*$/i;
const ALLOW = new Set(["approve", "allow"]);

/**
 * The shapes an approval id takes: the sidecar's UUID for a tool approval (`PreToolUse` hook),
 * or `approval_<hex>` for a continuation decision (ADR-0016).
 */
export const APPROVAL_ID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z]+_[0-9a-f]{16,})$/i;

export function parseApprovalCommand(text: string): ApprovalCommand | undefined {
  const match = COMMAND.exec(text);
  if (!match) return undefined;
  const verb = (match[1] ?? "").toLowerCase();
  const approvalId = match[2] ?? "";
  if (!APPROVAL_ID_PATTERN.test(approvalId)) return undefined;
  const reason = match[3]?.trim();
  return {
    decision: ALLOW.has(verb) ? "allow_once" : "deny",
    approvalId,
    ...(reason ? { reason } : {}),
  };
}

/** The line appended to a relayed approval request so the sender knows how to answer it. */
export function approvalInstruction(approvalId: string): string {
  return `Reply "approve ${approvalId}" or "deny ${approvalId} [reason]".`;
}
