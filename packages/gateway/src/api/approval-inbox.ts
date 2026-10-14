// The Attention inbox (#113 surface 23): pending approvals, oldest first, keyset pages of 25 up
// to 100, with the server total that feeds the nav badge. What the caller sees follows ADR-0022
// amendment 6: their workspaces, never another person's private chat, no Guest, and below Admin
// only the requests of runs they started (the ones they may answer, W5).
//
// The pending queue is bounded by the live and parked runs, so the visible set is computed in
// full and paged after the filter: the total is honest and a page is never short for a hidden
// row. The query reads `approvals_decision_created (decision, created_at, id)`.

import type { Approval, BotId, PageLimitPolicy } from "@deskmates/contracts";
import type { FastifyRequest } from "fastify";
import { actorLabel } from "../auth/principal.js";
import type { GatewayContext } from "../context.js";
import { type CursorKey, keysetPage, parseCursorQuery } from "./pagination.js";
import { requestTenant } from "./route-policy.js";
import { startedRun } from "./side-chat-guard.js";
import { actsBelowAdmin, visibleOfKind } from "./workspace-access.js";

export const PENDING_APPROVALS_PAGE: PageLimitPolicy = { default: 25, max: 100 };

export interface PendingInboxPage {
  approvals: Approval[];
  nextCursor?: string;
  total: number;
}

const keyOf = (approval: Approval): readonly CursorKey[] => [approval.createdAt, approval.id];

function after(approval: Approval, key: CursorKey[] | undefined): boolean {
  if (!key) return true;
  const [createdAt, id] = key as [string, string];
  return approval.createdAt > createdAt || (approval.createdAt === createdAt && approval.id > id);
}

/** The approvals the Attention inbox shows this caller, in order. */
export function visiblePending(
  ctx: GatewayContext,
  request: FastifyRequest,
  botId?: BotId,
): Approval[] {
  const rows = visibleOfKind(
    ctx,
    request,
    "approval",
    ctx.approvals.list({
      tenantId: requestTenant(request),
      status: "pending",
      ...(botId ? { botId } : {}),
    }),
  );
  const belowAdmin = new Map<string, boolean>();
  return rows.filter((approval) => {
    const workspaceId = ctx.ownership.workspaceOf("approval", approval.id) ?? "";
    if (!belowAdmin.has(workspaceId))
      belowAdmin.set(workspaceId, actsBelowAdmin(ctx, request, workspaceId));
    if (!belowAdmin.get(workspaceId)) return true;
    const run = ctx.runs.get(approval.runId);
    return run !== undefined && startedRun(ctx, request, run);
  });
}

export function pendingInboxPage(
  ctx: GatewayContext,
  request: FastifyRequest,
  query: { cursor?: unknown; limit?: unknown; botId?: string },
): PendingInboxPage {
  const scope = [
    requestTenant(request) ?? null,
    request.principal ? actorLabel(request.principal) : null,
    "approvals:pending",
    query.botId ?? null,
  ];
  const page = parseCursorQuery(query, PENDING_APPROVALS_PAGE, scope, ["string", "string"]);
  const visible = visiblePending(ctx, request, query.botId as BotId | undefined);
  const rest = visible.filter((approval) => after(approval, page.after));
  const { items, nextCursor } = keysetPage(rest.slice(0, page.limit + 1), page.limit, keyOf, scope);
  return { approvals: items, total: visible.length, ...(nextCursor ? { nextCursor } : {}) };
}
