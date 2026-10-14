// ADR-0022 amendment 6 W5 (narrowing amendment 1 A11/A12): below Admin in a run's workspace (a
// Member, or a `member` service principal) one stops, continues and answers approvals only of
// the runs one started: a run woken by one's own message, or any run of one's own one-bot chat.
// Everything else is the group's work, an Admin's. Admins, the operator credential, bots and the
// internal routes are not affected.

import { DeskmatesError, type MessageId, type RunId, isOwnSideChat } from "@deskmates/contracts";
import type { FastifyRequest } from "fastify";
import { actorLabel } from "../auth/principal.js";
import type { GatewayContext } from "../context.js";
import { actsBelowAdmin } from "./workspace-access.js";

/** Whether the request's actor started the run (W5). */
export function startedRun(
  ctx: GatewayContext,
  request: FastifyRequest,
  run: { threadId?: string | undefined; triggerKind: string; triggerRef: string },
): boolean {
  const actor = actorLabel(request.principal);
  const thread = run.threadId === undefined ? undefined : ctx.threads.get(run.threadId as never);
  if (thread !== undefined && isOwnSideChat(thread, ctx.threads.members(thread.id).length, actor))
    return true;
  if (run.triggerKind !== "thread_message") return false;
  return ctx.messages.get(run.triggerRef as MessageId)?.authorId === actor;
}

/** Throws 403 `forbidden` (`run_not_started_by_you`) unless the caller may act on the run. */
export function requireOwnRun(
  ctx: GatewayContext,
  request: FastifyRequest,
  run: { id: RunId; threadId?: string | undefined; triggerKind: string; triggerRef: string },
  action: string,
): void {
  const workspaceId = ctx.ownership.workspaceOf("run", run.id);
  if (workspaceId === undefined || !actsBelowAdmin(ctx, request, workspaceId)) return;
  if (!startedRun(ctx, request, run))
    throw new DeskmatesError("forbidden", `a Member may ${action} only for the runs they started`, {
      reason: "run_not_started_by_you",
    });
}
