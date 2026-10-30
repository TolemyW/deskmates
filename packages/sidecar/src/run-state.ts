// Mutable state one run's hook, permission callback and main loop share.

import type { ApprovalDecision, ApprovalId, DeferredAction } from "@deskmates/contracts";
import type { VaultReleases } from "./vault-release.js";

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
   * Stable dimensions of the deferred action. The replayed call takes the decision only when its
   * own dimensions equal these (issue #62 H3). A browser `ref` belongs to a snapshot of the old
   * process's MCP session, so the replayed call often fails; these are also what identifies the
   * retry that is the same action (ADR-0002 amendment 2).
   */
  deferredAction?: DeferredAction | undefined;
  /**
   * The approval's kind (issue #62 H3): an `egress` decision answers only the replayed call's
   * egress ask, a `tool` decision only its L2 ask. Absent from an older Gateway.
   */
  approvalKind?: "tool" | "egress" | undefined;
}

/** A decision the replayed call took, kept until that call's result says whether it worked. */
export interface ConsumedDecision {
  approvalId: ApprovalId;
  decision: ApprovalDecision;
  reason?: string | undefined;
  deferredAction: DeferredAction | undefined;
  /** Tool-use id of the replayed call whose result decides whether the retry may have it. */
  toolUseId: string;
  /** Canonical hash of the replayed call's action and input (not `description`); see RetryDecision. */
  inputSha256: string;
}

/** A decision the replayed call could not use, waiting for the first retry of the same action. */
export interface RetryDecision {
  approvalId: ApprovalId;
  decision: ApprovalDecision;
  reason?: string | undefined;
  deferredAction: DeferredAction;
  /** Tool-use id of the replayed call, so the ledger names both calls. */
  replayedToolUseId: string;
  /**
   * Canonical hash of the replayed call's action and input, `description` aside (issue #62 M15).
   * Only a browser call's `ref` goes stale between processes, so the retry of any other tool must
   * repeat the replayed input: the dimensions of a shell fetch (`curl *`, no origin) match every
   * later curl of any host and body. Key order and the model's reworded label do not count.
   */
  inputSha256: string;
}

export interface RunState {
  /** Set by the hook when it returned `defer`; makes the run end as `deferred`. */
  deferredApprovalId: ApprovalId | undefined;
  /**
   * Every approval the hook deferred in this process, in order (issue #62 M8). The OpenAI runtime
   * gates one turn's calls in parallel, so `deferredApprovalId` alone keeps only the last.
   */
  deferredApprovalIds: ApprovalId[];
  /** Tool-use id of the deferred call, reported in `RunEnded.pendingToolUseId`. */
  deferredToolUseId: string | undefined;
  /**
   * The decisions delivered with an `approval` trigger on resume, by the tool-use id of the call
   * each is for (a decision that names no call is keyed by ""). The SDK replays the deferred calls
   * through the hook first (ADR-0002 amendment 1); each replayed call takes its own decision, and
   * the first call that has none ends the replay and discards what is left. The OpenAI runtime
   * can park one turn on several calls and replays the decided ones first (issue #62 M8).
   */
  pendingDecisions: Map<string, PendingDecision>;
  /**
   * Set by the hook when a replayed call took its decision, by tool-use id; the main loop reads
   * the tool result for that call and either drops it (the call worked) or re-arms it as
   * `retryDecision`.
   */
  consumedDecisions: Map<string, ConsumedDecision>;
  /**
   * The decision waiting for the retry of a replayed call that failed. The first later L2 call in
   * this process whose `(toolName, targetOrigin, argumentPattern)` equal the deferred action's,
   * and, unless it is a browser call, whose input equals the replayed call's, consumes it; then it
   * is spent. It lives in this process only, never past it.
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
  /**
   * ADR-0029 decision 2: an event batch acknowledgement said the Gateway is draining. The next
   * PreToolUse hook defers its call instead of deciding it: that is the run's safe point.
   */
  drainRequested: boolean;
  /** Set when the hook deferred for the drain; the run ends `deferred` with the platform payload. */
  platformInterruption: "drain" | undefined;
  /** ADR-0045: credential releases the hook allowed, waiting for their tool handler. */
  vaultReleases: VaultReleases;
}

/**
 * The resume's decisions keyed by the call each is for, in trigger order; a second decision for
 * the same call is ignored (issue #62 M8).
 */
function decisionsByCall(pending: readonly PendingDecision[]): Map<string, PendingDecision> {
  const byCall = new Map<string, PendingDecision>();
  for (const decision of pending) {
    const key = decision.toolUseId ?? "";
    if (!byCall.has(key)) byCall.set(key, decision);
  }
  return byCall;
}

export function createRunState(
  pending: readonly PendingDecision[] = [],
  currentOrigin?: string,
): RunState {
  return {
    deferredApprovalId: undefined,
    deferredApprovalIds: [],
    deferredToolUseId: undefined,
    pendingDecisions: decisionsByCall(pending),
    consumedDecisions: new Map(),
    retryDecision: undefined,
    sdkSessionId: undefined,
    currentOrigin,
    deniedToolUseIds: new Set(),
    drainRequested: false,
    platformInterruption: undefined,
    vaultReleases: new Map(),
  };
}
