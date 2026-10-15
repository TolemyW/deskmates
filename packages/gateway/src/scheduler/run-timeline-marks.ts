// The Gateway's half of the run startup timeline (ADR-0037 decision 1): when an attempt left the
// queue, when its sandbox and process were ready, when the sidecar's `RunEnded` was taken and
// when the attempt's process was gone. Marks are `log` events of the attempt they describe.
// Recording is observational: a ledger failure here never changes what the run does.

import {
  type ApprovalId,
  type RunId,
  type RunTimelineMark,
  type StartRunRequest,
  timelineMark,
} from "@deskmates/contracts";
import type { GatewayContext } from "../context.js";
import type { RunRecord } from "../ledger/runs.js";

export function recordTimelineMark(
  ctx: Pick<GatewayContext, "events">,
  runId: RunId,
  attempt: number,
  mark: RunTimelineMark,
  attributes: Record<string, unknown> = {},
  now: Date = new Date(),
): void {
  try {
    ctx.events.append({
      runId,
      attempt,
      kind: "log",
      payload: { ...timelineMark(mark, now, attributes) },
    });
  } catch {
    // Timing is observational; the run goes on without the mark.
  }
}

/**
 * When the attempt became runnable. Attempt 1: the run's creation (the derived `routed` stage, so
 * nothing is recorded). A resume: the decision that released it, when one is on record; a
 * continuation without a decision time stays unknown rather than guessed.
 */
function readyAt(ctx: GatewayContext, before: RunRecord): string | undefined {
  const approvalId = before.resumePayload?.approvalId;
  if (!approvalId) return undefined;
  try {
    return ctx.approvals.get(approvalId as ApprovalId)?.decidedAt;
  } catch {
    return undefined;
  }
}

/** `attempt_started`: the scheduler took `before` off its queue or parked state. */
export function markAttemptStarted(
  ctx: GatewayContext,
  before: RunRecord,
  request: StartRunRequest,
): void {
  const ready = request.attempt > 1 ? readyAt(ctx, before) : undefined;
  recordTimelineMark(ctx, request.runId, request.attempt, "attempt_started", {
    start: request.attempt > 1 ? "resume" : "fresh",
    session: request.sdkSessionId === undefined ? "new" : "resumed",
    trigger: request.trigger.kind,
    ...(ready ? { readyAt: ready } : {}),
  });
}
