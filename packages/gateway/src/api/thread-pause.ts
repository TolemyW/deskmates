// Operator pause and resume of a thread (ADR-0005 amendment 3, decision 23), the status half of
// `PATCH /api/threads/:id`. The router does the pause or the resume; this records who acted in
// the audit log, in the same transaction. The route policy already makes it an Owner or Admin
// action and refuses a run token, like every operator route.

import { DeskmatesError, type ThreadId, type ThreadStatus } from "@deskmates/contracts";
import { AuditLog } from "../audit/audit-log.js";
import { type Principal, actorLabel } from "../auth/principal.js";
import type { GatewayContext } from "../context.js";

/** `status` of a thread patch: `paused` or `active`; undefined when the key is absent. */
export function threadStatusOf(body: Record<string, unknown>): ThreadStatus | undefined {
  const value = body.status;
  if (value === undefined) return undefined;
  if (value !== "paused" && value !== "active")
    throw new DeskmatesError("validation", 'status must be "paused" or "active"', {
      key: "status",
    });
  return value;
}

/** How a resume notice names who resumed the thread. */
function actorName(principal: Principal | undefined): string {
  if (principal?.kind === "user") return principal.displayName || principal.loginName || "a person";
  if (principal?.kind === "service") return principal.name;
  return "the operator";
}

/**
 * Pause (reason `operator`) or resume the thread. Asking for the state the thread is already in
 * changes nothing and writes no audit row; resuming a thread paused for either reason ends that
 * pause with one notice and a budget reset (decision 22).
 */
export function changeThreadStatus(
  ctx: Pick<GatewayContext, "bus" | "db" | "router" | "threads">,
  threadId: ThreadId,
  status: ThreadStatus,
  principal: Principal | undefined,
): void {
  const actor = actorLabel(principal);
  // Events reach the bus after the transaction commits.
  ctx.bus.batch(() =>
    ctx.db.transaction(() => {
      const before = ctx.threads.mustGet(threadId);
      const change =
        status === "paused"
          ? ctx.router.operatorPause(threadId)
          : ctx.router.operatorResume(threadId, actorName(principal));
      if (!change.changed) return;
      new AuditLog(ctx.db).record({
        action: status === "paused" ? "thread.pause" : "thread.resume",
        actor,
        workspaceId: before.workspaceId,
        targetKind: "thread",
        targetId: threadId,
        before: {
          status: before.status,
          ...(before.pauseReason ? { pauseReason: before.pauseReason } : {}),
        },
        after: {
          status: change.thread.status,
          ...(change.thread.pauseReason ? { pauseReason: change.thread.pauseReason } : {}),
          ...(change.cancelled.length > 0
            ? { cancelledRunIds: change.cancelled.map((run) => run.id) }
            : {}),
        },
      });
    })(),
  );
}
