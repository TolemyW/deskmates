// "Needs your confirmation" (ADR-0011 decision 4). The route names are the M2 review routes; the
// queue now holds only gated learned items. Applying one writes a trusted memory note with the
// human as source; it never edits MEMORY.md, SOUL, an approval rule or egress. Amendment 3 adds
// the queue read as review groups and bounded batch dispositions with preview and undo (A17 to
// A19); the list pages with the #113 contract (A23).

import {
  type BotId,
  type ConfirmationStatus,
  DeskmatesError,
  type PageLimitPolicy,
  type WorkspaceId,
  decidedByHuman,
} from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import type { GatewayContext } from "../context.js";
import { applyConfirmation } from "../memory/learned-writes.js";
import {
  commitBatch,
  listReviewGroups,
  previewBatch,
  recentBatches,
  undoBatch,
} from "../memory/review-groups.js";
import { requestActorId } from "./actor.js";
import { encodeCursor, parseCursorQuery } from "./pagination.js";
import { requestTenant } from "./route-policy.js";
import { asRecord } from "./validate.js";

/** #113 surface 20: 25 a page, 100 at most. */
const SUGGESTION_PAGE: PageLimitPolicy = { default: 25, max: 100 };
/** Review groups carry up to 50 items each: 10 groups a page, 25 at most. */
const GROUP_PAGE: PageLimitPolicy = { default: 10, max: 25 };

export function registerMemorySuggestionRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  app.get<{
    Querystring: {
      workspaceId?: string;
      botId?: string;
      status?: string;
      cursor?: string;
      limit?: string;
    };
  }>("/api/memory-suggestions", async (request) => {
    const status = request.query.status;
    if (status !== undefined && !["pending", "applied", "rejected"].includes(status))
      throw new DeskmatesError("validation", "Invalid memory suggestion status");
    const filter = {
      tenantId: requestTenant(request),
      ...(request.query.workspaceId
        ? { workspaceId: request.query.workspaceId as WorkspaceId }
        : {}),
      ...(request.query.botId ? { botId: request.query.botId as BotId } : {}),
      ...(status ? { status: status as ConfirmationStatus } : {}),
    };
    const scope = [
      "memory-suggestions",
      filter.tenantId,
      filter.workspaceId ?? null,
      filter.botId ?? null,
      filter.status ?? null,
    ];
    const query = parseCursorQuery(request.query, SUGGESTION_PAGE, scope, ["string", "string"]);
    const page = ctx.memory.confirmations.list({
      ...filter,
      limit: query.limit,
      ...(query.after ? { after: query.after as [string, string] } : {}),
    });
    const last = page.suggestions.at(-1);
    return {
      suggestions: page.suggestions,
      ...(page.more && last ? { nextCursor: encodeCursor([last.createdAt, last.id], scope) } : {}),
      // A23: the exact size of the filtered queue, for the heading.
      total: ctx.memory.confirmations.count(filter),
    };
  });

  app.post<{ Params: { id: string } }>("/api/memory-suggestions/:id/review", async (request) => {
    const body = asRecord(request.body);
    if (body.decision !== "apply" && body.decision !== "reject")
      throw new DeskmatesError("validation", "Expected apply or reject");
    const by = decidedByHuman(requestActorId(request, body));
    if (body.decision === "reject")
      return { suggestion: ctx.memory.confirmations.reject(request.params.id, by) };
    return applyConfirmation(ctx.memory.stores, request.params.id, by);
  });

  /** A17: the pending queue as review groups, newest activity first, with exact totals. */
  app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string } }>(
    "/api/workspaces/:id/memory-review/groups",
    async (request) => {
      const workspaceId = ctx.workspaces.mustGet(request.params.id as WorkspaceId).id;
      const scope = ["memory-review-groups", requestTenant(request), workspaceId];
      const query = parseCursorQuery(request.query, GROUP_PAGE, scope, ["string", "string"]);
      const page = listReviewGroups(ctx.memory.stores, workspaceId, {
        limit: query.limit,
        ...(query.after ? { after: query.after as [string, string] } : {}),
      });
      const last = page.groups.at(-1);
      return {
        groups: page.groups,
        ...(page.more && last
          ? { nextCursor: encodeCursor([last.newestAt, last.groupKey], scope) }
          : {}),
        totalGroups: page.totalGroups,
        totalItems: page.totalItems,
        batches: recentBatches(ctx.db, workspaceId, 5),
      };
    },
  );

  /** A18: what a batch would decide; changes nothing. */
  app.post<{ Params: { id: string } }>(
    "/api/workspaces/:id/memory-review/preview",
    async (request) => {
      const workspaceId = ctx.workspaces.mustGet(request.params.id as WorkspaceId).id;
      const body = asRecord(request.body);
      if (typeof body.groupKey !== "string")
        throw new DeskmatesError("validation", "Expected a review group", { field: "groupKey" });
      return {
        preview: previewBatch(ctx.memory.stores, workspaceId, body.groupKey, body.decision),
      };
    },
  );

  /** A18: commit a previewed batch; the same token returns the same batch. */
  app.post<{ Params: { id: string } }>(
    "/api/workspaces/:id/memory-review/batches",
    async (request) => {
      const workspaceId = ctx.workspaces.mustGet(request.params.id as WorkspaceId).id;
      const body = asRecord(request.body);
      if (typeof body.groupKey !== "string")
        throw new DeskmatesError("validation", "Expected a review group", { field: "groupKey" });
      return {
        batch: commitBatch(ctx.memory.stores, ctx.audit, {
          workspaceId,
          groupKey: body.groupKey,
          decision: body.decision,
          token: body.token,
          by: decidedByHuman(requestActorId(request, body)),
        }),
      };
    },
  );

  /** A19: undo a batch of this workspace as a whole; another workspace's batch is not found. */
  app.post<{ Params: { id: string } }>(
    "/api/workspaces/:id/memory-review/undo",
    async (request) => {
      const workspaceId = ctx.workspaces.mustGet(request.params.id as WorkspaceId).id;
      const body = asRecord(request.body);
      if (typeof body.batchId !== "string")
        throw new DeskmatesError("validation", "Expected a review batch", { field: "batchId" });
      return {
        batch: undoBatch(ctx.memory.stores, ctx.audit, {
          workspaceId,
          batchId: body.batchId,
          by: decidedByHuman(requestActorId(request, body)),
        }),
      };
    },
  );
}
