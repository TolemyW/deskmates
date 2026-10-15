// Bounded name lookups (#113 §3.2): a screen that labels ids asks for those ids, not for the
// whole list. `GET /api/bots?ids=`, `GET /api/threads?ids=` and `GET /api/workspaces?ids=` take
// at most 100 comma-separated ids and return only the rows the caller's unpaged list would hold
// among them, in list order. Unknown, archived, foreign-tenant and invisible ids are omitted,
// never reported, so a lookup tells no more than the list does.

import {
  type BotDefinition,
  type BotId,
  DeskmatesError,
  type Thread,
  type ThreadId,
  type Workspace,
  type WorkspaceId,
} from "@deskmates/contracts";
import type { FastifyRequest } from "fastify";
import type { GatewayContext } from "../context.js";
import { requestTenant } from "./route-policy.js";
import { readableWorkspaceIds, visibleOfKind } from "./workspace-access.js";

/** The most ids one lookup may name. */
export const ID_BATCH_MAX = 100;

/** Parse `a,b,c`: distinct and non-empty, at most {@link ID_BATCH_MAX}; more is a 400. */
export function parseIdBatch(raw: string, field = "ids"): string[] {
  const ids = [...new Set(raw.split(",").map((id) => id.trim()))].filter((id) => id !== "");
  if (ids.length > ID_BATCH_MAX)
    throw new DeskmatesError("validation", `at most ${ID_BATCH_MAX} ids per request`, {
      field,
      max: ID_BATCH_MAX,
    });
  return ids;
}

const listOrder = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) =>
  a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1;

/** The caller's tenant's active workspace, or undefined. */
function tenantWorkspace(
  ctx: GatewayContext,
  request: FastifyRequest,
  id: string,
): Workspace | undefined {
  if (ctx.ownership.tenantOf("workspace", id) !== requestTenant(request)) return undefined;
  return ctx.workspaces.get(id as WorkspaceId);
}

/** The named workspaces the caller belongs to (the unpaged list's rule, W1). */
export function workspacesByIds(
  ctx: GatewayContext,
  request: FastifyRequest,
  raw: string,
): Workspace[] {
  const readable = readableWorkspaceIds(ctx, request, "guest");
  return parseIdBatch(raw)
    .map((id) => tenantWorkspace(ctx, request, id))
    .filter((w): w is Workspace => w !== undefined && (!readable || readable.has(w.id)))
    .sort(listOrder);
}

/** The named active bots of the caller's workspaces, optionally of one workspace. */
export function botsByIds(
  ctx: GatewayContext,
  request: FastifyRequest,
  raw: string,
  workspaceId?: string,
): BotDefinition[] {
  const readable = readableWorkspaceIds(ctx, request, "guest");
  return parseIdBatch(raw)
    .map((id) => ctx.bots.get(id as BotId))
    .filter(
      (bot): bot is BotDefinition =>
        bot !== undefined &&
        (workspaceId === undefined || bot.workspaceId === workspaceId) &&
        tenantWorkspace(ctx, request, bot.workspaceId) !== undefined &&
        (!readable || readable.has(bot.workspaceId)),
    )
    .sort(listOrder);
}

/** The named threads the caller may see: no other person's private chat, no bus for a Guest. */
export function threadsByIds(
  ctx: GatewayContext,
  request: FastifyRequest,
  raw: string,
  workspaceId?: string,
): Thread[] {
  const rows = parseIdBatch(raw)
    .map((id) => ctx.threads.get(id as ThreadId))
    .filter(
      (thread): thread is Thread =>
        thread !== undefined &&
        (workspaceId === undefined || thread.workspaceId === workspaceId) &&
        tenantWorkspace(ctx, request, thread.workspaceId) !== undefined,
    )
    .sort(listOrder);
  return visibleOfKind(ctx, request, "thread", rows, "guest");
}
