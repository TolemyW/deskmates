// Automatic approval review (ADR-0002 amendment 4, B4). The reviewer is a tool-free model job;
// its whole answer is one JSON object. The Gateway parses it here and refuses anything else, so a
// reply it cannot read settles nothing and the request goes to a human.

/** What a reviewer may answer. Never Always: only humans store rules. */
export type ApprovalReviewVerdict = "allow_once" | "deny" | "escalate";

export interface ApprovalReviewResult {
  verdict: ApprovalReviewVerdict;
  reason: string;
}

/** The workspace setting as the operator API returns it (B1). */
export interface WorkspaceAutoApproval {
  workspaceId: string;
  enabled: boolean;
}

/** Bumped whenever the reviewer prompt or the package shape changes; frozen in the run config. */
export const APPROVAL_REVIEW_POLICY_VERSION = 1;

const REVIEW_REASON_MAX_CHARS = 500;

/**
 * Parse a reviewer reply: one JSON object with `verdict` and `reason`, optionally inside a code
 * fence. Undefined for anything else, including an unknown verdict or `allow_always`.
 */
export function parseApprovalReview(reply: string): ApprovalReviewResult | undefined {
  const text = reply.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const { verdict, reason } = parsed as { verdict?: unknown; reason?: unknown };
  if (verdict !== "allow_once" && verdict !== "deny" && verdict !== "escalate") return undefined;
  if (typeof reason !== "string" || reason.trim() === "") return undefined;
  return { verdict, reason: reason.trim().slice(0, REVIEW_REASON_MAX_CHARS) };
}

/** `decided_by` of a reviewer decision. */
export function decidedByReviewer(model: string): string {
  return `reviewer:${model}`;
}
