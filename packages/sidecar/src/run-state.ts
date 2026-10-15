// Mutable state one run's hook, permission callback and main loop share.

import type { ApprovalDecision, ApprovalId, DeferredAction } from "@deskmates/contracts";

export interface PendingDecision {
  approvalId: ApprovalId;
  decision: ApprovalDecision;
  /** The deny reason the Gateway recorded (an expiry says so, ADR-0002 amendment 3, A7). */
  reason?: string | undefined;
  /**
   * SDK tool-use id of the call the decision is for. The hook applies the decision only to the
   * replayed call with this id; when it is absent or does not match, the replayed call is judged
   * as a fresh L2 call and the decision is discarded.
   */
  toolUseId: string | undefined;
  /**
   * Stable dimensions of the deferred action. A browser `ref` belongs to a snapshot of the old
   * process's MCP session, so the replayed call often fails; these are what identifies the retry
   * that is the same action (ADR-0002 amendment 2).
   */
  deferredAction?: DeferredAction | undefined;
}

/** A decision the replayed call took, kept until that call's result says whether it worked. */
export interface ConsumedDecision {
  approvalId: ApprovalId;
  decision: ApprovalDecision;
  reason?: string | undefined;
  deferredAction: DeferredAction | undefined;
  /** Tool-use id of the replayed call whose result decides whether the retry may have it. */
  toolUseId: string;
}

/** A decision the replayed call could not use, waiting for the first retry of the same action. */
export interface RetryDecision {
  approvalId: ApprovalId;
  decision: ApprovalDecision;
  reason?: string | undefined;
  deferredAction: DeferredAction;
  /** Tool-use id of the replayed call, so the ledger names both calls. */
  replayedToolUseId: string;
}

export interface RunState {
  /** Set by the hook when it returned `defer`; makes the run end as `deferred`. */
  deferredApprovalId: ApprovalId | undefined;
  /** Tool-use id of the deferred call, reported in `RunEnded.pendingToolUseId`. */
  deferredToolUseId: string | undefined;
  /**
   * A human's decision delivered with an `approval` trigger on resume. The SDK replays the
   * deferred call through the hook first (ADR-0002 amendment 1); the hook settles this on its
   * first call, whatever that call is.
   */
  pendingDecision: PendingDecision | undefined;
  /**
   * Set by the hook when the replayed call took the decision; the main loop reads the tool result
   * for this call and either drops it (the call worked) or re-arms it as `retryDecision`.
   */
  consumedDecision: ConsumedDecision | undefined;
  /**
   * The decision waiting for the retry of a replayed call that failed. The first later L2 call in
   * this process whose `(toolName, targetOrigin, argumentPattern)` equal the deferred action's
   * consumes it; then it is spent. It lives in this process only, never past it.
   */
  retryDecision: RetryDecision | undefined;
  /** Session id reported by the SDK's init or result message. */
  sdkSessionId: string | undefined;
  /**
   * Origin of the page the run last navigated to, set by the hook from every navigation it lets
   * through egress. A browser call carries no URL of its own, so this is the origin an approval
   * rule matches on; a call made before any navigation has none and matches no rule that names
   * one (ADR-0002 amendment 2, A3). On a resume it starts as the origin the parked process
   * reported, because the browser is still on that page though this process never navigated.
   */
  currentOrigin: string | undefined;
  /**
   * Tool-use ids the hook or the backstop refused (deny or defer). A refused call never reaches
   * the MCP proxy, so it is not one of the proxy's page-changing actions; the run loop skips
   * these when it pairs actions with capture files (`screenshots.ts`).
   */
  deniedToolUseIds: Set<string>;
}

export function createRunState(pending?: PendingDecision, currentOrigin?: string): RunState {
  return {
    deferredApprovalId: undefined,
    deferredToolUseId: undefined,
    pendingDecision: pending,
    consumedDecision: undefined,
    retryDecision: undefined,
    sdkSessionId: undefined,
    currentOrigin,
    deniedToolUseIds: new Set(),
  };
}
