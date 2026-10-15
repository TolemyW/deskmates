// Memory maintenance (ADR-0011 amendment 4, issue #85 phase 2): "Needs revalidation", Knowledge
// drafts from observations, and model organisation (topic labels and split proposals). Reads
// never queue a job; a draft publishes nothing; every decision is an Admin's and is audited.

import { type PageLimitPolicy, type WorkspaceId, decidedByHuman } from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import type { GatewayContext } from "../context.js";
import { draftFromObservations } from "../knowledge/observation-drafts.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import { requestActorId } from "./actor.js";
import { encodeCursor, parseCursorQuery } from "./pagination.js";
import { requestTenant } from "./route-policy.js";
import { asRecord } from "./validate.js";

/** #113 contract: 25 a page, 100 at most. */
const PAGE: PageLimitPolicy = { default: 25, max: 100 };

type WorkspaceParams = { Params: { id: string } };
type ItemParams = { Params: { id: string; itemId: string } };
type PageQuery = { Querystring: { cursor?: string; limit?: string } };

export function registerMemoryMaintenanceRoutes(
  app: FastifyInstance,
  ctx: GatewayContext,
  scheduler: Scheduler,
): void {
  const workspaceOf = (id: string): WorkspaceId => ctx.workspaces.mustGet(id as WorkspaceId).id;

  /** A26: open flags after a sweep of this workspace, with exact totals per reason. */
  app.get<WorkspaceParams & PageQuery>(
    "/api/workspaces/:id/memory/revalidations",
    async (request) => {
      const workspaceId = workspaceOf(request.params.id);
      const scope = ["memory-revalidations", requestTenant(request), workspaceId];
      const query = parseCursorQuery(request.query, PAGE, scope, ["string", "string"]);
      ctx.memory.freshness.sweep(workspaceId);
      const page = ctx.memory.freshness.page(workspaceId, {
        limit: query.limit,
        ...(query.after ? { after: query.after as [string, string] } : {}),
      });
      const last = page.items.at(-1);
      return {
        revalidations: page.items,
        ...(page.more && last
          ? { nextCursor: encodeCursor([last.flaggedAt, last.id], scope) }
          : {}),
        total: page.total,
        byReason: page.byReason,
      };
    },
  );

  /** A27: still true or dismiss. */
  app.post<ItemParams>("/api/workspaces/:id/memory/revalidations/:itemId", async (request) => {
    const workspaceId = workspaceOf(request.params.id);
    const body = asRecord(request.body);
    return {
      revalidation: ctx.memory.freshness.decide(ctx.audit, {
        workspaceId,
        id: request.params.itemId,
        decision: body.decision,
        by: decidedByHuman(requestActorId(request, body)),
      }),
    };
  });

  /** A29: a pending Knowledge proposal citing the selected notes; publishes nothing. */
  app.post<WorkspaceParams>(
    "/api/workspaces/:id/memory/document-drafts",
    async (request, reply) => {
      const workspace = ctx.workspaces.mustGet(request.params.id as WorkspaceId);
      const body = asRecord(request.body);
      const proposal = draftFromObservations(ctx.memory.entries, ctx.knowledge, {
        tenantId: requestTenant(request),
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        entryIds: body.entryIds,
        title: body.title,
        targetDocumentId: body.targetDocumentId,
      });
      return reply.code(201).send({ proposal });
    },
  );

  /** A30: the latest organisation job of the workspace, if any. */
  app.get<WorkspaceParams>("/api/workspaces/:id/memory/organize", async (request) => {
    const workspaceId = workspaceOf(request.params.id);
    const job = ctx.modelJobs.organize.latest(workspaceId);
    return job ? { job } : {};
  });

  /** A30: queue one job; a pending one is returned instead. */
  app.post<WorkspaceParams>("/api/workspaces/:id/memory/organize", async (request, reply) => {
    const workspaceId = workspaceOf(request.params.id);
    const body = asRecord(request.body ?? {});
    const queued = ctx.modelJobs.organize.request({
      workspaceId,
      requestedBy: decidedByHuman(requestActorId(request, body)),
    });
    if (queued.run) {
      ctx.bus.publish({ type: "run_status", run: queued.run });
      scheduler.kick();
    }
    return reply.code(202).send({ job: queued.job });
  });

  /** A31: every model label of the workspace back to the deterministic topic. */
  app.post<WorkspaceParams>(
    "/api/workspaces/:id/memory/organize/reset-labels",
    async (request) => ({
      reset: ctx.modelJobs.organize.resetLabels(workspaceOf(request.params.id)),
    }),
  );

  /** A32: pending split proposals, newest first. */
  app.get<WorkspaceParams & PageQuery>("/api/workspaces/:id/memory/splits", async (request) => {
    const workspaceId = workspaceOf(request.params.id);
    const scope = ["memory-splits", requestTenant(request), workspaceId];
    const query = parseCursorQuery(request.query, PAGE, scope, ["string", "string"]);
    const page = ctx.modelJobs.organize.pendingSplits(workspaceId, {
      limit: query.limit,
      ...(query.after ? { after: query.after as [string, string] } : {}),
    });
    const last = page.splits.at(-1);
    return {
      splits: page.splits,
      ...(page.more && last ? { nextCursor: encodeCursor([last.createdAt, last.id], scope) } : {}),
      total: page.total,
    };
  });

  /** A32: accept, reject or undo a split. */
  app.post<ItemParams>("/api/workspaces/:id/memory/splits/:itemId", async (request) => {
    const workspaceId = workspaceOf(request.params.id);
    const body = asRecord(request.body);
    return {
      split: ctx.modelJobs.organize.decideSplit({
        workspaceId,
        id: request.params.itemId,
        decision: body.decision,
        by: decidedByHuman(requestActorId(request, body)),
      }),
    };
  });
}
