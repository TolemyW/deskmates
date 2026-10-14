// Operator routes for learned memory (ADR-0011): list entries per workspace and per bot with scope,
// trust, authority, source and age; edit, forget, undo and confirm; close a thread's task into an
// episode; queue a consolidation. The run-side `memory_search` route is registered separately,
// inside the run-token scope, and only ever searches the run's own workspace.

import {
  type BotId,
  DeskmatesError,
  type PageLimitPolicy,
  type RunId,
  type ThreadId,
  type WorkspaceId,
  decidedByHuman,
  isTerminal,
} from "@deskmates/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { GatewayContext } from "../context.js";
import type { StoredScope } from "../memory/entries.js";
import { closeThreadTask } from "../memory/episodes.js";
import { searchMemory, searchMemoryPage } from "../memory/search.js";
import { isLive } from "../memory/validity.js";
import { confirmEntry, editEntry, forgetEntry, undoEntry } from "../memory/versions.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import { requestActorId } from "./actor.js";
import { encodeCursor, parseCursorQuery, parseOffsetQuery } from "./pagination.js";
import { requestTenant } from "./route-policy.js";
import { asRecord, optionalString } from "./validate.js";

const SCOPES: ReadonlySet<string> = new Set<StoredScope>(["task", "workspace", "bot"]);

function scopeOf(raw: string | undefined): StoredScope | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (!SCOPES.has(raw)) throw new DeskmatesError("validation", "Invalid memory scope");
  return raw as StoredScope;
}

/** #113 slice K2 (amendment 3, A23): one policy per list. */
const ENTRY_PAGE: PageLimitPolicy = { default: 25, max: 100 };
const SEARCH_PAGE: PageLimitPolicy = { default: 20, max: 50 };
const VERSION_PAGE: PageLimitPolicy = { default: 25, max: 100 };
const TOPIC_PAGE: PageLimitPolicy = { default: 25, max: 100 };

function by(request: FastifyRequest): string {
  return decidedByHuman(requestActorId(request, request.body));
}

export function registerLearnedMemoryRoutes(
  app: FastifyInstance,
  ctx: GatewayContext,
  scheduler: Scheduler,
): void {
  const { memory } = ctx;

  app.get<{
    Params: { id: string };
    Querystring: {
      botId?: string;
      scope?: string;
      threadId?: string;
      topic?: string;
      includeForgotten?: string;
      cursor?: string;
      limit?: string;
    };
  }>("/api/workspaces/:id/memory", async (request) => {
    const workspace = ctx.workspaces.mustGet(request.params.id as WorkspaceId);
    const scope = scopeOf(request.query.scope);
    const filter = {
      workspaceId: workspace.id,
      ...(request.query.botId ? { botId: request.query.botId as BotId } : {}),
      ...(scope ? { scope } : {}),
      ...(request.query.threadId ? { threadId: request.query.threadId as ThreadId } : {}),
      ...(request.query.topic ? { topic: request.query.topic.toLowerCase() } : {}),
      includeTombstoned: request.query.includeForgotten === "1",
    };
    const cursorScope = [
      "memory-entries",
      requestTenant(request),
      filter.workspaceId,
      filter.botId ?? null,
      filter.scope ?? null,
      filter.threadId ?? null,
      filter.topic ?? null,
      filter.includeTombstoned,
    ];
    const query = parseCursorQuery(request.query, ENTRY_PAGE, cursorScope, ["string", "string"]);
    const page = memory.entries.page({
      ...filter,
      limit: query.limit,
      ...(query.after ? { after: query.after as [string, string] } : {}),
    });
    const now = new Date();
    const last = page.entries.at(-1);
    return {
      entries: page.entries.map((entry) => ({ ...entry, live: isLive(entry, now) })),
      ...(page.more && last
        ? { nextCursor: encodeCursor([last.observedAt, last.id], cursorScope) }
        : {}),
    };
  });

  /** A20: topic tags of the entries not forgotten, most entries first, with an exact total. */
  app.get<{
    Params: { id: string };
    Querystring: { botId?: string; scope?: string; offset?: string; limit?: string };
  }>("/api/workspaces/:id/memory/topics", async (request) => {
    const workspaceId = ctx.workspaces.mustGet(request.params.id as WorkspaceId).id;
    const scope = scopeOf(request.query.scope);
    const page = parseOffsetQuery(request.query, TOPIC_PAGE);
    const result = memory.entries.topics(
      {
        workspaceId,
        ...(request.query.botId ? { botId: request.query.botId as BotId } : {}),
        ...(scope ? { scope } : {}),
      },
      page,
    );
    return { topics: result.topics, offset: page.offset, limit: page.limit, total: result.total };
  });

  app.get<{
    Params: { id: string };
    Querystring: { q?: string; scope?: string; cursor?: string; limit?: string };
  }>("/api/workspaces/:id/memory/search", async (request) => {
    const workspaceId = ctx.workspaces.mustGet(request.params.id as WorkspaceId).id;
    const scope = scopeOf(request.query.scope);
    // Rank order has no stable key to resume from: the cursor is an offset bound to the query.
    const cursorScope = [
      "memory-search",
      requestTenant(request),
      workspaceId,
      request.query.q ?? "",
      scope ?? null,
    ];
    const query = parseCursorQuery(request.query, SEARCH_PAGE, cursorScope, ["number"]);
    const offset = Number(query.after?.[0] ?? 0);
    const page = searchMemoryPage(ctx.db, {
      workspaceId,
      query: request.query.q ?? "",
      ...(scope ? { scope } : {}),
      limit: query.limit,
      offset,
      now: new Date(),
    });
    return {
      entries: page.hits.map((hit) => ({
        ...memory.entries.mustGetIn(workspaceId, hit.id),
        live: true,
      })),
      // A15: a further page is announced, never dropped silently.
      ...(page.more ? { nextCursor: encodeCursor([offset + page.hits.length], cursorScope) } : {}),
    };
  });

  /** Where an entry came from, and what replaced it or what it replaced (A10, A12). */
  app.get<{ Params: { id: string } }>("/api/memory/entries/:id/provenance", async (request) => {
    const entry = memory.entries.mustGet(request.params.id);
    return {
      sources: memory.entries.sources(entry.workspaceId, entry.id),
      supersessions: memory.entries.supersessions(entry.workspaceId, entry.id),
    };
  });

  /** Every memory version a run's model context received, and how (A13). */
  app.get<{ Params: { id: string } }>("/api/runs/:id/memory-versions", async (request) => {
    const run = ctx.runs.mustGet(request.params.id as RunId);
    return { versions: memory.supplied.list(ctx.bots.mustGet(run.botId).workspaceId, run.id) };
  });

  /** A23: newest first; "Load older" follows `nextCursor`. */
  app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string } }>(
    "/api/memory/entries/:id/versions",
    async (request) => {
      const entry = memory.entries.mustGet(request.params.id);
      const cursorScope = ["memory-versions", entry.workspaceId, entry.id];
      const query = parseCursorQuery(request.query, VERSION_PAGE, cursorScope, ["number"]);
      const page = memory.entries.versionsPage(entry.id, {
        limit: query.limit,
        ...(query.after ? { before: Number(query.after[0]) } : {}),
      });
      const last = page.versions.at(-1);
      return {
        versions: page.versions,
        ...(page.more && last ? { nextCursor: encodeCursor([last.version], cursorScope) } : {}),
      };
    },
  );

  /** Exact versions by `entryId@version`, for trace export and replay (decision 12). */
  app.get<{ Querystring: { refs?: string } }>("/api/memory/versions", async (request) => {
    const refs = (request.query.refs ?? "").split(",").filter(Boolean).slice(0, 500);
    const tenantId = requestTenant(request);
    const versions = refs.flatMap((ref) => {
      const at = ref.lastIndexOf("@");
      const version = Number(ref.slice(at + 1));
      if (at <= 0 || !Number.isSafeInteger(version)) return [];
      // Another tenant's entry is answered exactly like a missing one: left out.
      if (ctx.ownership.tenantOf("memoryEntry", ref.slice(0, at)) !== tenantId) return [];
      const entry = memory.entries.get(ref.slice(0, at));
      const found = entry ? memory.entries.version(entry.id, version) : undefined;
      return entry && found
        ? [
            {
              ...found,
              scope: entry.scope,
              kind: entry.kind,
              observedAt: entry.observedAt,
              ...(entry.threadId ? { threadId: entry.threadId } : {}),
              ...(entry.learnedBy ? { learnedBy: entry.learnedBy } : {}),
            },
          ]
        : [];
    });
    return { versions };
  });

  const entryWorkspace = (id: string) => memory.entries.mustGet(id).workspaceId;

  app.patch<{ Params: { id: string } }>("/api/memory/entries/:id", async (request) => {
    const body = asRecord(request.body);
    const expectedVersion = body.expectedVersion;
    if (
      expectedVersion !== undefined &&
      (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 1)
    )
      throw new DeskmatesError("validation", "Expected a positive memory version");
    return {
      entry: editEntry(
        memory.entries,
        entryWorkspace(request.params.id),
        request.params.id,
        body.body,
        by(request),
        expectedVersion as number | undefined,
      ),
    };
  });
  app.post<{ Params: { id: string } }>("/api/memory/entries/:id/forget", async (request) => ({
    entry: forgetEntry(
      memory.entries,
      entryWorkspace(request.params.id),
      request.params.id,
      by(request),
    ),
  }));
  app.post<{ Params: { id: string } }>("/api/memory/entries/:id/undo", async (request) => ({
    entry: undoEntry(
      memory.entries,
      entryWorkspace(request.params.id),
      request.params.id,
      by(request),
    ),
  }));
  app.post<{ Params: { id: string } }>("/api/memory/entries/:id/confirm", async (request) => ({
    entry: confirmEntry(
      memory.entries,
      entryWorkspace(request.params.id),
      request.params.id,
      by(request),
    ),
  }));

  app.post<{ Params: { id: string } }>("/api/threads/:id/close-task", async (request) => {
    const thread = ctx.threads.mustGet(request.params.id as ThreadId);
    if (ctx.runs.list({ threadId: thread.id }).some((run) => !isTerminal(run.status)))
      throw new DeskmatesError(
        "lane_busy",
        "Wait for this conversation's current runs to finish before closing task notes",
      );
    const closed = closeThreadTask(memory.entries, thread, by(request));
    return { episode: closed.episode ?? null, distilled: closed.distilled };
  });

  app.post<{ Params: { id: string } }>(
    "/api/bots/:id/memory/consolidate",
    async (request, reply) => {
      const run = memory.consolidation.request(ctx.bots.mustGet(request.params.id as BotId).id);
      ctx.bus.publish({ type: "run_status", run });
      scheduler.kick();
      return reply.code(202).send({ run });
    },
  );
}

/** Registered inside the run-token preHandler: a run searches its own workspace only. */
export function registerMemoryInternalRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  app.get<{ Params: { runId: string }; Querystring: { q?: string; scope?: string } }>(
    "/internal/runs/:runId/memory/search",
    async (request) => {
      const run = ctx.runs.mustGet(request.params.runId as RunId);
      const workspaceId = ctx.bots.mustGet(run.botId).workspaceId;
      const scope = scopeOf(request.query.scope);
      const entries = searchMemory(ctx.db, {
        workspaceId,
        query: request.query.q ?? "",
        ...(scope ? { scope } : {}),
      });
      // A13: what reached the run's context is recorded with its exact version.
      ctx.memory.supplied.record(
        workspaceId,
        run.id,
        entries.map((hit) => ({ entryId: hit.id, version: hit.version })),
        "search",
      );
      return { entries };
    },
  );
}
