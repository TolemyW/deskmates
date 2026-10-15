// Turn-exhaustion continuations under the approval mode (ADR-0002 amendment 6, D6). In
// `approve_all` a continuation within the limit the run froze at its first start is decided
// `allow_once` by `mode:approve_all` as soon as it exists; past the limit the run does not fail
// outright, its continuation goes to the reviewer, whose `allow_once` continues once more and
// whose `deny` stops it, and an escalation or a failed review posts it to the thread. In `manual`
// and `automatic` nothing here applies.

import { APPROVAL_MODE_ACTOR, type ApprovalId } from "@deskmates/contracts";
import type { GatewayContext } from "../context.js";
import type { GatewayEvent } from "../events/bus.js";
import type { RunRecord } from "../ledger/runs.js";
import { continuationAllowed, continuationPolicy } from "../scheduler/run-limits.js";

/** How a turn-exhausted run's continuation is answered. */
export type ContinuationPlan =
  /** Today's path: a person or a member bot decides (manual and automatic). */
  | "ask"
  /** approve_all, within the limit: continue at once. */
  | "auto_continue"
  /** approve_all, past the limit: the reviewer decides. */
  | "review"
  /** No continuation may be offered: the run fails as before. */
  | "fail";

export function continuationPlan(
  ctx: Pick<GatewayContext, "broker">,
  run: RunRecord,
  count: number,
  hasSession: boolean,
): ContinuationPlan {
  if (!hasSession) return "fail";
  const approveAll = ctx.broker.reviews?.mode(run) === "approve_all";
  if (continuationAllowed(run.config, count)) return approveAll ? "auto_continue" : "ask";
  return approveAll ? "review" : "fail";
}

/**
 * Settle a just-created continuation request by its plan. Returns false when nothing was settled
 * or queued, so the caller posts the request for people as it always has.
 */
export function settleContinuationByMode(
  ctx: GatewayContext,
  published: GatewayEvent[],
  run: RunRecord,
  approvalId: ApprovalId,
  plan: ContinuationPlan,
): boolean {
  if (plan === "auto_continue") {
    ctx.broker.decide(
      approvalId,
      "allow_once",
      APPROVAL_MODE_ACTOR,
      "approve all: continuing within the workspace continuation limit",
    );
    ctx.events.append({
      runId: run.id,
      kind: "approval",
      payload: { phase: "mode_allowed", mode: "approve_all", approvalId, continuation: true },
    });
    return true;
  }
  if (plan !== "review") return false;
  const reviews = ctx.broker.reviews;
  const approval = ctx.approvals.mustGet(approvalId);
  const owner = ctx.runs.mustGet(run.id);
  const queued = reviews?.queueContinuation(owner, approval, {
    continuationCount: Number(owner.config.continuationCount ?? 0),
    continuationLimit: continuationPolicy(owner.config).limit,
    handoffPath: typeof owner.config.handoffPath === "string" ? owner.config.handoffPath : null,
  });
  if (!queued || !("queued" in queued)) {
    ctx.events.append({
      runId: run.id,
      kind: "approval",
      payload: {
        phase: "review_skipped",
        approvalId,
        reason: queued && "skipped" in queued ? queued.skipped : "off",
        continuation: true,
      },
    });
    return false;
  }
  ctx.events.append({
    runId: run.id,
    kind: "approval",
    payload: {
      phase: "review_queued",
      approvalId,
      reviewRunId: queued.queued.id,
      continuation: true,
    },
  });
  published.push({ type: "run_status", run: queued.queued });
  return true;
}
