import {
  DeskmatesError,
  type KnowledgeProposal,
  PAGE_LIMIT_MAX,
  type PageLimitPolicy,
  type RunId,
  decidedByHuman,
} from "@deskmates/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { GatewayContext } from "../context.js";
import { KNOWLEDGE_SEARCH_LIMIT } from "../knowledge/knowledge.js";
import { requestActorId } from "./actor.js";
import { type CursorKey, keysetPage, parseCursorQuery, parseOffsetQuery } from "./pagination.js";
import { requestTenant } from "./route-policy.js";
import { asRecord, optionalString, requireString } from "./validate.js";

type Id = { Params: { id: string } };
type PageQuery = { cursor?: string; limit?: string; offset?: string };

/** Page sizes (#113): documents, search and proposals 25 of at most 100; history the same. */
export const KNOWLEDGE_PAGE: PageLimitPolicy = { default: 25, max: PAGE_LIMIT_MAX };
const reviewer = (request: FastifyRequest, body: Record<string, unknown>): string =>
  decidedByHuman(requestActorId(request, body));
const after = (keys: CursorKey[] | undefined) =>
  keys ? ([keys[0], keys[1]] as [string, string]) : undefined;
const KEYS = ["string", "string"] as const;

/** Registered inside the authenticated operator scope. */
export function registerKnowledgeRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  app.get<{ Querystring: PageQuery & { q?: string } }>("/api/knowledge", async (request) => {
    const tenantId = requestTenant(request);
    const q = request.query.q;
    if (q) {
      // Search pages over the rank with an honest total of matches, never only the top few.
      const { offset, limit } = parseOffsetQuery(request.query, KNOWLEDGE_SEARCH_LIMIT);
      const page = ctx.knowledge.searchPage(tenantId, q, offset, limit);
      return { documents: page.items, offset, limit, total: page.total };
    }
    const scope = ["knowledge.documents", tenantId];
    const query = parseCursorQuery(request.query, KNOWLEDGE_PAGE, scope, KEYS);
    const page = keysetPage(
      ctx.knowledge.documentRows(tenantId, query.limit, after(query.after)).rows,
      query.limit,
      (row) => row.key,
      scope,
    );
    return {
      documents: page.items.map((row) => row.item),
      total: ctx.knowledge.documentCount(tenantId),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  });
  app.get<{ Querystring: PageQuery & { status?: string } }>(
    "/api/knowledge/proposals",
    async (request) => {
      const status = request.query.status ?? "pending";
      if (!["pending", "approved", "rejected"].includes(status))
        throw new DeskmatesError("validation", "Invalid proposal status");
      const tenantId = requestTenant(request);
      const typed = status as KnowledgeProposal["status"];
      const scope = ["knowledge.proposals", tenantId, typed];
      const query = parseCursorQuery(request.query, KNOWLEDGE_PAGE, scope, KEYS);
      const page = keysetPage(
        ctx.knowledge.proposalRows(tenantId, typed, query.limit, after(query.after)).rows,
        query.limit,
        (row) => row.key,
        scope,
      );
      return {
        proposals: page.items.map((row) => row.item),
        total: ctx.knowledge.proposalCount(tenantId, typed),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    },
  );
  app.post("/api/knowledge/proposals", async (request, reply) => {
    const body = asRecord(request.body);
    return reply
      .code(201)
      .send({ proposal: ctx.knowledge.propose(requestTenant(request), body.title, body.body) });
  });
  app.post<Id>("/api/knowledge/proposals/:id/review", async (request) => {
    const body = asRecord(request.body);
    if (body.decision !== "approve" && body.decision !== "reject")
      throw new DeskmatesError("validation", "Expected approve or reject");
    return {
      proposal: ctx.knowledge.review(
        requestTenant(request),
        request.params.id,
        body.decision,
        reviewer(request, body),
      ),
    };
  });
  app.post("/api/knowledge/versions/cleanup", async () => ctx.knowledge.cleanupOrphanVersions());
  app.get<{ Params: { id: string }; Querystring: PageQuery }>(
    "/api/knowledge/:id/history",
    async (request) => {
      const { limit } = parseOffsetQuery({ limit: request.query.limit }, KNOWLEDGE_PAGE);
      const page = ctx.knowledge.history(
        requestTenant(request),
        request.params.id,
        request.query.cursor,
        limit,
      );
      return { versions: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
    },
  );
  app.get<Id>("/api/knowledge/:id", async (request) => ({
    document: ctx.knowledge.read(requestTenant(request), request.params.id),
  }));
  app.get<Id>("/api/knowledge/:id/export", async (request, reply) => {
    const doc = ctx.knowledge.read(requestTenant(request), request.params.id);
    return reply
      .header("content-type", "text/markdown; charset=utf-8")
      .header("content-disposition", `attachment; filename="${doc.id}.md"`)
      .send(doc.body);
  });
  app.patch<Id>("/api/knowledge/:id", async (request) => {
    const body = asRecord(request.body);
    if (typeof body.version !== "number" || !Number.isSafeInteger(body.version) || body.version < 1)
      throw new DeskmatesError("validation", "Expected current document version");
    return {
      document: ctx.knowledge.edit(
        requestTenant(request),
        request.params.id,
        body.title,
        body.body,
        body.version,
        reviewer(request, body),
      ),
    };
  });
}

/** Registered inside the existing run-token preHandler, never on the operator listener. */
export function registerKnowledgeInternalRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  app.get<{ Params: { runId: string }; Querystring: { q?: string } }>(
    "/internal/runs/:runId/knowledge/search",
    async (request) => {
      // A run reads its own tenant's Knowledge only (ADR-0022 P2).
      const tenantId = ctx.ownership.runTenant(request.params.runId as RunId);
      return { documents: ctx.knowledge.search(tenantId, request.query.q ?? "") };
    },
  );
  app.get<{ Params: { runId: string; id: string } }>(
    "/internal/runs/:runId/knowledge/:id",
    async (request) => {
      const tenantId = ctx.ownership.runTenant(request.params.runId as RunId);
      return { document: ctx.knowledge.read(tenantId, request.params.id) };
    },
  );
  app.post<{ Params: { runId: string } }>(
    "/internal/runs/:runId/knowledge/proposals",
    async (request, reply) => {
      const run = ctx.runs.mustGet(request.params.runId as RunId);
      const body = asRecord(request.body);
      const proposal = ctx.knowledge.propose(
        ctx.ownership.runTenant(run.id),
        requireString(body, "title"),
        requireString(body, "body"),
        run.id,
      );
      ctx.events.append({
        runId: run.id,
        kind: "log",
        payload: { source: "knowledge", op: "proposed", proposalId: proposal.id },
      });
      return reply.code(201).send({ proposal });
    },
  );
}
