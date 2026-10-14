import {
  type BotId,
  PAGE_LIMIT_MAX,
  type PageLimitPolicy,
  type WorkspaceId,
} from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import type { GatewayContext } from "../context.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import { TrashLifecycle } from "../workspaces/trash-lifecycle.js";
import { requestActorId } from "./actor.js";
import { parseOffsetQuery } from "./pagination.js";

/** Archived workspaces: 25 a page, at most 100 (#113). */
export const TRASH_PAGE: PageLimitPolicy = { default: 25, max: PAGE_LIMIT_MAX };
import { requestTenant } from "./route-policy.js";
import { asRecord, requireString } from "./validate.js";

export function registerTrashRoutes(
  app: FastifyInstance,
  ctx: GatewayContext,
  scheduler: Scheduler,
): void {
  const trash = new TrashLifecycle(ctx, scheduler);

  // Archived workspaces page by offset with an honest total (#113). Archived bots still come
  // whole: only the unmounted bot-management screen reads them, and it is out of #113's scope.
  app.get<{ Querystring: Record<string, unknown> }>("/api/trash", async (request) => {
    const tenantId = requestTenant(request);
    const { offset, limit } = parseOffsetQuery(request.query, TRASH_PAGE);
    const page = trash.workspacePage(tenantId, offset, limit);
    return {
      workspaces: page.workspaces,
      offset,
      limit,
      total: page.total,
      bots: ctx.bots.listArchived(tenantId),
    };
  });

  app.post<{ Params: { id: string } }>("/api/workspaces/:id/archive", async (request) => ({
    workspace: await trash.archiveWorkspace(
      request.params.id as WorkspaceId,
      requestActorId(request, request.body),
    ),
  }));
  app.post<{ Params: { id: string } }>("/api/workspaces/:id/restore", async (request) => ({
    workspace: trash.restoreWorkspace(
      request.params.id as WorkspaceId,
      requestActorId(request, request.body),
    ),
  }));
  app.delete<{ Params: { id: string } }>("/api/workspaces/:id", async (request, reply) => {
    const body = asRecord(request.body);
    await trash.deleteWorkspace(
      request.params.id as WorkspaceId,
      requireString(body, "name"),
      requestActorId(request, body),
      requestTenant(request),
    );
    return reply.send({ deleted: true });
  });

  app.post<{ Params: { id: string } }>("/api/bots/:id/archive", async (request) => ({
    bot: trash.archiveBot(request.params.id as BotId, requestActorId(request, request.body)),
  }));
  app.post<{ Params: { id: string } }>("/api/bots/:id/restore", async (request) => ({
    bot: trash.restoreBot(request.params.id as BotId, requestActorId(request, request.body)),
  }));
  app.delete<{ Params: { id: string } }>("/api/bots/:id", async (request, reply) => {
    const body = asRecord(request.body);
    trash.deleteBot(
      request.params.id as BotId,
      requireString(body, "name"),
      requestActorId(request, body),
      requestTenant(request),
    );
    return reply.send({ deleted: true });
  });
}
