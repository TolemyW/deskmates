// Automatic approval review (ADR-0002 amendment 4, B4). The reviewer is a tool-free model job;
// its whole answer is one JSON object. The Gateway parses it here and refuses anything else, so a
// reply it cannot read settles nothing and the request goes to a human.

/** What a reviewer may answer. Never Always: only humans store rules. */
export type ApprovalReviewVerdict = "allow_once" | "deny" | "escalate";

export interface ApprovalReviewResult {
  verdict: ApprovalReviewVerdict;
  reason: string;
}

/**
 * Who answers an L2 request no stored rule answered (ADR-0002 amendment 6, D1): a person
 * (`manual`), an independent AI reviewer first (`automatic`, the default for a new workspace), or
 * nobody, because the workspace allows every gated action (`approve_all`).
 */
export type ApprovalMode = "manual" | "automatic" | "approve_all";

export const APPROVAL_MODES: readonly ApprovalMode[] = ["manual", "automatic", "approve_all"];

/** D1: a new workspace starts in automatic review. */
export const APPROVAL_MODE_DEFAULT: ApprovalMode = "automatic";

/** D4: `decided_by` of an action the `approve_all` mode allowed without asking anyone. */
export const APPROVAL_MODE_ACTOR = "mode:approve_all";

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return typeof value === "string" && (APPROVAL_MODES as readonly string[]).includes(value);
}

/** The workspace setting as the operator API returns it (amendment 6, D1). */
export interface WorkspaceAutoApproval {
  workspaceId: string;
  mode: ApprovalMode;
  /** Whether the reviewer runs: `mode === "automatic"`. Kept for older clients. */
  enabled: boolean;
  /**
   * Minutes an undecided request waits before it expires to deny (ADR-0002 amendment 3, A7).
   * A whole number from `APPROVAL_EXPIRY_MIN_MINUTES` to `APPROVAL_EXPIRY_MAX_MINUTES`.
   */
  expiryMinutes: number;
}

/** Amendment 6, D7: an hour; the reminder goes out when a third is left, at 40 minutes. */
export const APPROVAL_EXPIRY_DEFAULT_MINUTES = 60;
export const APPROVAL_EXPIRY_MIN_MINUTES = 1;
export const APPROVAL_EXPIRY_MAX_MINUTES = 1440;

/** Bumped whenever the reviewer prompt or the package shape changes; frozen in the run config. */
export const APPROVAL_REVIEW_POLICY_VERSION = 2;

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
