// The search proxy (ADR-0049): `POST /internal/runs/:runId/search`, run token scoped by the
// internal scope's preHandler. The sidecar's `web_search` sends a bounded query; the Gateway
// checks it, builds the one SearXNG request, forwards it once with no retry, filters and records
// the answer and returns the results. It never fetches a result URL, never resolves a result host
// and never calls a generative model.

import { createHash } from "node:crypto";
import {
  DeskmatesError,
  type RunId,
  WEB_SEARCH_DEFAULT_RESULTS,
  WEB_SEARCH_MAX_PER_RUN,
  WEB_SEARCH_TIMEOUT_MS,
  type WebSearchResponse,
  type WorkspaceId,
  webSearchRequestProblem,
} from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import type { SearchServiceConfig } from "../config/search.js";
import type { GatewayContext } from "../context.js";
import type { RunRecord } from "../ledger/runs.js";
import { bearerToken } from "../model-proxy/model-proxy.js";
import { type SearchRecordInput, SearchStore } from "./search-store.js";
import {
  REDACTED_QUERY_MARK,
  emptySearchEngineFailure,
  parseSearxngAnswer,
  searxngRequest,
} from "./searxng.js";

interface SearchModule {
  store: SearchStore;
  fetch: typeof globalThis.fetch;
  /** Searches of a run forwarded but not yet recorded; they hold a slot of the per-run cap. */
  inFlight: Map<RunId, number>;
}

const modules = new WeakMap<GatewayContext, SearchModule>();

function searchOf(ctx: GatewayContext): SearchModule {
  let module = modules.get(ctx);
  if (!module) {
    module = { store: new SearchStore(ctx.db), fetch: globalThis.fetch, inFlight: new Map() };
    modules.set(ctx, module);
  }
  return module;
}

/** Tests point the proxy at the testkit's fake SearXNG. */
export function setSearchFetch(ctx: GatewayContext, fetch: typeof globalThis.fetch): void {
  searchOf(ctx).fetch = fetch;
}

/** The context's search rows, for tests and later readers. */
export function searchStore(ctx: GatewayContext): SearchStore {
  return searchOf(ctx).store;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

interface Call {
  ctx: GatewayContext;
  run: RunRecord;
  workspaceId: WorkspaceId;
  service: SearchServiceConfig;
  query: string;
  redacted: boolean;
  language: string | null;
  maxResults: number;
}

function record(
  call: Call,
  outcome: Pick<SearchRecordInput, "status" | "errorCode"> &
    Partial<Pick<SearchRecordInput, "resultCount" | "droppedCount" | "latencyMs">>,
): string {
  const id = searchOf(call.ctx).store.record({
    workspaceId: call.workspaceId,
    runId: call.run.id,
    attempt: call.run.attempt,
    endpointSha256: call.service.endpointSha256,
    status: outcome.status,
    errorCode: outcome.errorCode,
    querySha256: call.query === "" ? null : sha256(call.query),
    queryChars: call.query.length,
    redacted: call.redacted,
    language: call.language,
    maxResults: call.maxResults,
    resultCount: outcome.resultCount ?? null,
    droppedCount: outcome.droppedCount ?? null,
    latencyMs: outcome.latencyMs ?? null,
  });
  call.ctx.events.append({
    runId: call.run.id,
    attempt: call.run.attempt,
    kind: "log",
    payload: {
      source: "search",
      searchId: id,
      status: outcome.status,
      ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
      ...(outcome.resultCount === undefined ? {} : { results: outcome.resultCount }),
      ...(outcome.droppedCount === undefined ? {} : { dropped: outcome.droppedCount }),
      ...(call.redacted ? { redacted: true } : {}),
    },
  });
  return id;
}

function unavailable(call: Call, reason: string, started: number, status?: number): never {
  record(call, { status: "failed", errorCode: reason, latencyMs: Date.now() - started });
  throw new DeskmatesError("operation_unavailable", `the search service ${reason}`, {
    reason,
    operation: "web_search",
    ...(status === undefined ? {} : { status }),
  });
}

/** The run's own token in the query, replaced once more (decision 6, defence in depth). */
function scrubRunToken(query: string, token: string | undefined): { query: string; hit: boolean } {
  if (!token || token.length < 8 || !query.includes(token)) return { query, hit: false };
  return { query: query.replaceAll(token, REDACTED_QUERY_MARK), hit: true };
}

async function search(
  ctx: GatewayContext,
  service: SearchServiceConfig,
  runId: string,
  raw: unknown,
  runToken: string | undefined,
): Promise<WebSearchResponse> {
  const body = (raw ?? {}) as Record<string, unknown>;
  const problem = webSearchRequestProblem(body);
  if (problem) throw new DeskmatesError("validation", problem);
  if (body.redacted !== undefined && typeof body.redacted !== "boolean")
    throw new DeskmatesError("validation", "redacted must be a boolean");
  const run = ctx.runs.mustGet(runId as RunId);
  // Decision 12: only a run whose row says `on` was offered the tool; anything else never reaches
  // the service, whatever the workspace switch says now.
  if (run.config.webSearch !== "on")
    throw new DeskmatesError("not_found", "web search was not offered to this run", {
      operation: "web_search",
    });
  const workspaceId = ctx.bots.mustGet(run.botId).workspaceId;
  const scrubbed = scrubRunToken((body.query as string).trim(), runToken);
  const call: Call = {
    ctx,
    run,
    workspaceId,
    service,
    query: scrubbed.query,
    redacted: body.redacted === true || scrubbed.hit,
    language: typeof body.language === "string" ? body.language : null,
    maxResults: typeof body.maxResults === "number" ? body.maxResults : WEB_SEARCH_DEFAULT_RESULTS,
  };
  // Decision 5: at most this many forwarded searches per run. The slot is reserved before the
  // fetch, so parallel calls cannot all pass the check; the recorded row takes it over.
  const module = searchOf(ctx);
  const inFlight = module.inFlight.get(run.id) ?? 0;
  if (module.store.forwardedCount(run.id) + inFlight >= WEB_SEARCH_MAX_PER_RUN) {
    record(call, { status: "refused", errorCode: "run_cap" });
    throw new DeskmatesError(
      "rate_limited",
      `this run has used its ${WEB_SEARCH_MAX_PER_RUN} searches`,
      { operation: "web_search", maxPerRun: WEB_SEARCH_MAX_PER_RUN },
    );
  }
  module.inFlight.set(run.id, inFlight + 1);
  try {
    return await forward(ctx, call, workspaceId);
  } finally {
    const left = (module.inFlight.get(run.id) ?? 1) - 1;
    if (left > 0) module.inFlight.set(run.id, left);
    else module.inFlight.delete(run.id);
  }
}

/** The one upstream request of a search whose cap slot is reserved; always records its outcome. */
async function forward(
  ctx: GatewayContext,
  call: Call,
  workspaceId: WorkspaceId,
): Promise<WebSearchResponse> {
  const service = call.service;
  const request = searxngRequest(service, {
    query: call.query,
    ...(call.language === null ? {} : { language: call.language }),
  });
  const started = Date.now();
  let response: Response;
  try {
    response = await searchOf(ctx).fetch(request.url, {
      ...request.init,
      signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return unavailable(call, timedOut ? "timed_out" : "unreachable", started);
  }
  const text = await response.text().catch(() => "");
  if (!response.ok) return unavailable(call, "answered_error", started, response.status);
  let answer: unknown;
  try {
    answer = JSON.parse(text);
  } catch {
    return unavailable(call, "answered_malformed", started);
  }
  const allowlist = ctx.workspaces.mustGet(workspaceId).egressAllowlist;
  const parsed = parseSearxngAnswer(answer, call.maxResults, allowlist);
  if (!parsed) return unavailable(call, "answered_malformed", started);
  if (emptySearchEngineFailure(answer)) return unavailable(call, "engines_unavailable", started);
  const searchId = record(call, {
    status: "succeeded",
    errorCode: null,
    resultCount: parsed.results.length,
    droppedCount: parsed.dropped,
    latencyMs: Date.now() - started,
  });
  return { searchId, results: parsed.results, dropped: parsed.dropped };
}

/** Registered inside the internal scope, whose preHandler checks the run token against the path. */
export function registerSearchInternalRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  app.post<{ Params: { runId: string } }>("/internal/runs/:runId/search", async (request) => {
    const service = ctx.config.search;
    if (!service)
      throw new DeskmatesError("not_found", "web search is not configured", {
        operation: "web_search",
      });
    return search(
      ctx,
      service,
      request.params.runId,
      request.body,
      bearerToken(request.headers.authorization),
    );
  });
}
