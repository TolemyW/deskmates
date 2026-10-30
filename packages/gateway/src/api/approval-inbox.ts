// The Attention inbox (#113 surface 23): pending approvals, oldest first, keyset pages of 25 up
// to 100, with the server total that feeds the nav badge. What the caller sees follows ADR-0022
// amendment 6: their workspaces, never another person's private chat, no Guest, and below Admin
// only the requests of runs they started (the ones they may answer, W5).
//
// The pending queue is bounded by the live and parked runs, so the visible set is computed in
// full and paged after the filter: the total is honest and a page is never short for a hidden
// row. The query reads `approvals_decision_created (decision, created_at, id)`.

import { createHash } from "node:crypto";
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

/** One human-facing queue row: the oldest request represents every identical pending action. */
export interface PendingApprovalGroup {
  key: string;
  approval: Approval;
  count: number;
}

export interface PendingApprovalGroupPage {
  groups: PendingApprovalGroup[];
  nextCursor?: string;
  totalGroups: number;
  totalApprovals: number;
}

const keyOf = (approval: Approval): readonly CursorKey[] => [approval.createdAt, approval.id];

/** Browser snapshot refs are deliberately unstable; they do not make two clicks different. */
function stableInput(value: unknown, field?: string): unknown {
  if (field === "ref") return undefined;
  if (Array.isArray(value)) return value.map((item) => stableInput(item));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([key, item]) => {
        const stable = stableInput(item, key);
        return stable === undefined ? [] : [[key, stable]];
      }),
  );
}

/** Opaque identity for "same bot, same action"; never an authority or a stored decision. */
export function pendingApprovalGroupKey(approval: Approval): string {
  const action = approval.action;
  const identity = JSON.stringify({
    botId: approval.botId,
    kind: approval.kind ?? "tool",
    toolName: action.toolName,
    targetOrigin: action.targetOrigin ?? null,
    argumentPattern: action.argumentPattern ?? null,
    argumentSummary: action.argumentSummary ?? null,
    input: stableInput(action.input),
  });
  return createHash("sha256").update(identity).digest("base64url");
}

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

/** Group the whole visible queue before paging, so a repeated cron action is one row on one page. */
export function visiblePendingGroups(
  ctx: GatewayContext,
  request: FastifyRequest,
  botId?: BotId,
): PendingApprovalGroup[] {
  const groups = new Map<string, PendingApprovalGroup>();
  for (const approval of visiblePending(ctx, request, botId)) {
    const key = pendingApprovalGroupKey(approval);
    const existing = groups.get(key);
    if (existing) existing.count += 1;
    else groups.set(key, { key, approval, count: 1 });
  }
  return [...groups.values()].sort(
    (a, b) =>
      a.approval.createdAt.localeCompare(b.approval.createdAt) || a.key.localeCompare(b.key),
  );
}

export function pendingApprovalGroupPage(
  ctx: GatewayContext,
  request: FastifyRequest,
  query: { cursor?: unknown; limit?: unknown; botId?: string },
): PendingApprovalGroupPage {
  const scope = [
    requestTenant(request) ?? null,
    request.principal ? actorLabel(request.principal) : null,
    "approval-groups:pending",
    query.botId ?? null,
  ];
  const page = parseCursorQuery(query, PENDING_APPROVALS_PAGE, scope, ["string", "string"]);
  const approvals = visiblePending(ctx, request, query.botId as BotId | undefined);
  const groups = visiblePendingGroups(ctx, request, query.botId as BotId | undefined);
  const afterGroup = groups.filter((group) => {
    if (!page.after) return true;
    const [createdAt, key] = page.after as [string, string];
    return (
      group.approval.createdAt > createdAt ||
      (group.approval.createdAt === createdAt && group.key > key)
    );
  });
  const { items, nextCursor } = keysetPage(
    afterGroup.slice(0, page.limit + 1),
    page.limit,
    (group) => [group.approval.createdAt, group.key],
    scope,
  );
  return {
    groups: items,
    totalGroups: groups.length,
    totalApprovals: approvals.length,
    ...(nextCursor ? { nextCursor } : {}),
  };
}
