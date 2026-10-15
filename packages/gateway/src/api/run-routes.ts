// Ledger read routes: runs, their events and usage. Every run carries `visibility` (issue #70):
// what it did that someone can see, beside a status whose meaning does not change.
//
// Bounded reads (#113 slice R, pagination coverage plan surfaces 27, 30, 32): the run list is a
// keyset page of finished runs, newest first; every unfinished run (bounded by the lanes) comes
// whole on the first page, or alone through `phase=active`. Run events are a newest window with
// Load older or a bounded tail. Two
// summary routes replace the whole-tenant run reads Contacts and Learned memory used to make.

import {
  type BotId,
  DeskmatesError,
  type PageLimitPolicy,
  type RunId,
  type RunStatus,
  type ThreadId,
  type WorkspaceId,
  isRunFailureClass,
  welcomeDelivery,
} from "@deskmates/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { GatewayContext } from "../context.js";
import { classifyFailure } from "../ledger/failure-class.js";
import { RunMarkStore } from "../ledger/run-marks.js";
import { withVisibility } from "../ledger/run-visibility.js";
import type { RunPageFilter, RunRecord } from "../ledger/runs.js";
import { combineReceipts, usageReceipts } from "../ledger/usage-receipts.js";
import { welcomeGreetingsPosted } from "../threads/welcome-delivery.js";
import { keysetPage, parseCursorQuery } from "./pagination.js";
import { requestTenant } from "./route-policy.js";
import { limitOf, seqParam } from "./seq-slices.js";
import { readableWorkspaceIds, visibleOfKind } from "./workspace-access.js";

/** Finished runs: 20 per page, at most 100 (plan §1 rows 27 and 30). */
export const RUN_PAGE: PageLimitPolicy = { default: 20, max: 100 };
/** A run's newest events: 200 by default, at most 500 (plan §1 row 32). */
export const RUN_EVENT_WINDOW: PageLimitPolicy = { default: 200, max: 500 };
/** A tail after `afterSeq`: at most 500 per request; `hasMore` says to ask again. */
export const RUN_EVENT_TAIL: PageLimitPolicy = { default: 500, max: 500 };

const RUN_KEYS = ["string", "string"] as const;

const RUN_STATUSES: readonly RunStatus[] = [
  "queued",
  "running",
  "waiting_approval_live",
  "waiting_approval",
  "waiting_browser",
  "waiting_continuation",
  "succeeded",
  "silent",
  "failed",
  "cancelled",
  "stopped",
];

interface RunListQuery {
  threadId?: string;
  botId?: string;
  workspaceId?: string;
  phase?: string;
  cursor?: string;
  limit?: string;
  /** Issue #11: one status or a comma-separated list. */
  status?: string;
  lane?: string;
  since?: string;
  until?: string;
  failureClass?: string;
  /** Free text over `error`. */
  q?: string;
}

type RunAuditFilter = Pick<
  RunPageFilter,
  "statuses" | "lane" | "since" | "until" | "failureClass" | "errorText"
>;

/** The audit filters of the run list (issue #11, ADR-0042 decision 2), validated. */
function auditFilters(q: RunListQuery): RunAuditFilter {
  const filters: RunAuditFilter = {};
  if (q.status !== undefined && q.status !== "") {
    const statuses = q.status.split(",").map((s) => s.trim());
    for (const status of statuses)
      if (!RUN_STATUSES.includes(status as RunStatus))
        throw new DeskmatesError("validation", `unknown run status ${status}`, { field: "status" });
    filters.statuses = [...new Set(statuses)].sort() as RunStatus[];
  }
  if (q.lane !== undefined && q.lane !== "") {
    if (q.lane !== "interactive" && q.lane !== "background")
      throw new DeskmatesError("validation", "lane must be interactive or background", {
        field: "lane",
      });
    filters.lane = q.lane;
  }
  for (const key of ["since", "until"] as const) {
    const raw = q[key];
    if (raw === undefined || raw === "") continue;
    const at = Date.parse(raw);
    if (!Number.isFinite(at))
      throw new DeskmatesError("validation", `${key} must be an ISO 8601 time`, { field: key });
    filters[key] = new Date(at).toISOString();
  }
  if (q.failureClass !== undefined && q.failureClass !== "") {
    if (!isRunFailureClass(q.failureClass))
      throw new DeskmatesError("validation", `unknown failure class ${q.failureClass}`, {
        field: "failureClass",
      });
    filters.failureClass = q.failureClass;
  }
  const text = q.q?.trim();
  if (text) filters.errorText = text.slice(0, 200);
  return filters;
}

function viewerOf(request: FastifyRequest): string | undefined {
  const principal = request.principal;
  return principal?.kind === "user" ? principal.userId : undefined;
}

export function registerRunRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  /** The run API's view of a run: visibility, welcome delivery, activity summary and rounds. */
  const views = (runs: RunRecord[]) => {
    // ADR-0033: each run's current summary and the rounds it answers, for Activity grouping.
    const summaries = ctx.activitySummaries.forRuns(runs);
    const rounds = ctx.rounds.roundsOfRuns(runs.map((run) => run.id));
    // ADR-0042: the derived failure class and the operator's mark, on the index and the cards.
    const marks = new RunMarkStore(ctx.db).forRuns(runs.map((run) => run.id));
    // ADR-0024 amendment 2, decision 11: a welcome reports whether its greeting reached the chat.
    const greeted = welcomeGreetingsPosted(ctx.db, runs);
    return withVisibility(ctx.db, runs).map((run) => ({
      ...run,
      ...(run.triggerKind === "welcome"
        ? { welcomeDelivery: welcomeDelivery(run, greeted.has(run.id)) }
        : {}),
      ...(summaries.has(run.id) ? { activitySummary: summaries.get(run.id) } : {}),
      ...(rounds.has(run.id) ? { roundMessageIds: rounds.get(run.id) } : {}),
      ...(run.error !== undefined ? { failureClass: classifyFailure(run.error) } : {}),
      ...(marks.has(run.id) ? { mark: marks.get(run.id) } : {}),
    }));
  };

  app.get<{ Querystring: RunListQuery }>("/api/runs", async (request) => {
    const q = request.query;
    if (q.phase !== undefined && q.phase !== "active" && q.phase !== "finished")
      throw new DeskmatesError("validation", "phase must be active or finished", {
        field: "phase",
      });
    const tenantId = requestTenant(request);
    const viewerUserId = viewerOf(request);
    const readable = readableWorkspaceIds(ctx, request, "member");
    const filter = {
      tenantId,
      ...(readable ? { workspaceIds: [...readable].sort() } : {}),
      ...(q.workspaceId ? { workspaceId: q.workspaceId as WorkspaceId } : {}),
      ...(q.threadId ? { threadId: q.threadId as ThreadId } : {}),
      ...(q.botId ? { botId: q.botId as BotId } : {}),
      ...(q.phase ? { phase: q.phase as "active" | "finished" } : {}),
      ...(viewerUserId ? { viewerUserId } : {}),
      ...auditFilters(q),
    };
    // Every unfinished run is bounded by the lanes, so it is listed whole, never paged.
    if (q.phase === "active") {
      if (q.cursor !== undefined || q.limit !== undefined)
        throw new DeskmatesError("validation", "active runs are not paged", { field: "cursor" });
      return { runs: views(visibleOfKind(ctx, request, "run", ctx.runs.listPage(filter, {}))) };
    }
    // Only workspaces the caller is a Member of, and no other person's private chat
    // (ADR-0022 amendment 6 W1, W7), both in SQL so a page is never short.
    const scope = [
      "runs",
      tenantId,
      filter.workspaceIds?.join(",") ?? null,
      q.workspaceId ?? null,
      q.threadId ?? null,
      q.botId ?? null,
      q.phase ?? null,
      viewerUserId ?? null,
      filter.statuses?.join(",") ?? null,
      filter.lane ?? null,
      filter.since ?? null,
      filter.until ?? null,
      filter.failureClass ?? null,
      filter.errorText ?? null,
    ];
    const query = parseCursorQuery(q, RUN_PAGE, scope, RUN_KEYS);
    // Without a phase, the first page also carries every unfinished run, so one request shows a
    // chat's or bot's live work and its newest history; the cursor walks the finished runs only.
    const finished = { ...filter, phase: "finished" as const };
    const rows = ctx.runs.listPage(finished, {
      limit: query.limit,
      ...(query.after ? { after: query.after as [string, string] } : {}),
    });
    const page = keysetPage(rows, query.limit, (run) => [run.createdAt, run.id], scope);
    const active =
      q.phase === undefined && !query.after
        ? ctx.runs.listPage({ ...filter, phase: "active" }, {})
        : [];
    return {
      runs: views(visibleOfKind(ctx, request, "run", [...active, ...page.items])),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  });

  /** Each bot's newest run in one workspace, for the Contacts rail (replaces a tenant-wide read). */
  app.get<{ Querystring: { workspaceId?: string } }>("/api/runs/latest-by-bot", async (request) => {
    const workspaceId = request.query.workspaceId;
    if (!workspaceId)
      throw new DeskmatesError("validation", "workspaceId is required", { field: "workspaceId" });
    const runs = ctx.runs.latestPerBot(workspaceId as WorkspaceId, viewerOf(request));
    return { runs: views(visibleOfKind(ctx, request, "run", runs)) };
  });

  /** The newest memory index observation in one workspace, for Learned memory. */
  app.get<{ Querystring: { workspaceId?: string } }>("/api/runs/memory-index", async (request) => {
    const workspaceId = request.query.workspaceId;
    if (!workspaceId)
      throw new DeskmatesError("validation", "workspaceId is required", { field: "workspaceId" });
    const run = ctx.runs.latestMemoryIndex(workspaceId as WorkspaceId, viewerOf(request));
    const memory = run?.config.memory as { counts?: Record<string, number> } | undefined;
    return {
      observation: run && memory?.counts ? { runId: run.id, counts: memory.counts } : null,
    };
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id", async (request) => {
    const id = request.params.id as RunId;
    const [run] = views([ctx.runs.mustGet(id)]);
    const accounting = usageReceipts(ctx.db, id);
    return { run, usage: combineReceipts(accounting.rows), usageCoverage: accounting.coverage };
  });

  app.get<{
    Params: { id: string };
    Querystring: { afterSeq?: string; beforeSeq?: string; limit?: string };
  }>("/api/runs/:id/events", async (request) => {
    const id = request.params.id as RunId;
    ctx.runs.mustGet(id);
    const afterSeq = seqParam(request.query.afterSeq, "afterSeq");
    const beforeSeq = seqParam(request.query.beforeSeq, "beforeSeq");
    if (afterSeq !== undefined && beforeSeq !== undefined)
      throw new DeskmatesError("validation", "use afterSeq or beforeSeq, not both", {
        field: "beforeSeq",
      });
    if (afterSeq !== undefined) {
      const limit = limitOf(request.query.limit, RUN_EVENT_TAIL);
      const slice = ctx.events.listSlice(id, { afterSeq, limit });
      return { events: slice.events, hasMore: slice.more };
    }
    const slice = ctx.events.listSlice(id, {
      ...(beforeSeq !== undefined ? { beforeSeq } : {}),
      limit: limitOf(request.query.limit, RUN_EVENT_WINDOW),
    });
    return { events: slice.events, hasOlder: slice.more };
  });

  /**
   * The run's latest screenshot event, or null (issue #9): the thumbnail an approval card shows
   * of what the bot was looking at, without reading the whole ledger for it.
   */
  app.get<{ Params: { id: string } }>("/api/runs/:id/screenshot", async (request) => {
    const id = request.params.id as RunId;
    ctx.runs.mustGet(id);
    return { screenshot: ctx.events.latestOfKind(id, "screenshot") ?? null };
  });
}
