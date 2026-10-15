// Demo routes of the run drawer: run lists, detail with usage, events, context metrics, cancel
// (only the named run, issue #76) and the continue-or-stop decision.

import {
  type RunContextMetrics,
  type RunId,
  buildRunTimeline,
  isTerminal,
} from "@deskmates/contracts";
import type { RunView } from "../../api/types.js";
import type { DemoFeature, DemoRequest } from "../../demo/feature.js";
import { type Result, notFound, ok } from "../../demo/result.js";
import { type DemoState, ignoreCancelled, summary } from "../../demo/state.js";
import { finishLater } from "../../demo/team.js";

export const demo: DemoFeature = { route };

function route(req: DemoRequest, s: DemoState): Result | Promise<Result> | undefined {
  const { method, path, query: q, body: b } = req;
  const m = (re: RegExp) => req.match(re);
  let x: RegExpMatchArray | null;
  if (path === "/api/runs" && method === "GET") {
    // #113 slice R: newest first; unfinished runs whole, finished ones paged by an offset cursor.
    const threadId = q.get("threadId");
    const botId = q.get("botId");
    const phase = q.get("phase");
    const all = [...s.runs.values()]
      .filter(
        (r) =>
          (!threadId || r.threadId === threadId) &&
          (!botId || r.botId === botId) &&
          (phase === null || (phase === "active") === !isTerminal(r.status)),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    if (phase === "active") return ok({ runs: all });
    const finished = all.filter((r) => isTerminal(r.status));
    const offset = Number(q.get("cursor") ?? 0) || 0;
    const limit = Number(q.get("limit") ?? 20) || 20;
    const live = phase === null && offset === 0 ? all.filter((r) => !isTerminal(r.status)) : [];
    const runs = [...live, ...finished.slice(offset, offset + limit)];
    return ok({
      runs,
      ...(offset + limit < finished.length ? { nextCursor: String(offset + limit) } : {}),
    });
  }
  if (path === "/api/runs/latest-by-bot" && method === "GET") {
    const workspaceId = q.get("workspaceId");
    const latest = new Map<string, RunView>();
    for (const run of s.runs.values()) {
      if (s.bots.find((b) => b.id === run.botId)?.workspaceId !== workspaceId) continue;
      const current = latest.get(run.botId);
      if (!current || run.createdAt >= current.createdAt) latest.set(run.botId, run);
    }
    return ok({ runs: [...latest.values()] });
  }
  if (path === "/api/runs/memory-index" && method === "GET") return ok({ observation: null });
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/runs\/([^/]+)$/))) {
    const run = s.runs.get(decodeURIComponent(x[1] ?? "") as RunId);
    if (!run) return notFound("run");
    return ok({ run, usage: s.usage.get(run.id) ?? [] });
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/runs\/([^/]+)\/events$/))) {
    const run = s.runs.get(decodeURIComponent(x[1] ?? "") as RunId);
    if (!run) return notFound("run");
    const events = s.events.get(run.id) ?? [];
    const afterSeq = q.get("afterSeq");
    if (afterSeq !== null)
      return ok({ events: events.filter((e) => e.seq > Number(afterSeq)), hasMore: false });
    const before = Number(q.get("beforeSeq") ?? Number.MAX_SAFE_INTEGER);
    const limit = Number(q.get("limit") ?? 200) || 200;
    const older = events.filter((e) => e.seq < before);
    return ok({ events: older.slice(-limit), hasOlder: older.length > limit });
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/runs\/([^/]+)\/screenshot$/))) {
    const run = s.runs.get(decodeURIComponent(x[1] ?? "") as RunId);
    if (!run) return notFound("run");
    const shots = (s.events.get(run.id) ?? []).filter((e) => e.kind === "screenshot");
    return ok({ screenshot: shots.at(-1) ?? null });
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/runs\/([^/]+)\/context$/))) {
    const run = s.runs.get(decodeURIComponent(x[1] ?? "") as RunId);
    if (!run) return notFound("run");
    const turns = (s.events.get(run.id) ?? []).filter((e) => e.kind === "turn_usage");
    const metrics: RunContextMetrics = {
      turns: turns.length,
      peakInputTokens: turns.length
        ? Math.max(...turns.map((t) => Number(t.payload.inputTokens ?? 0)))
        : null,
      p95InputTokens: turns.length
        ? Math.max(...turns.map((t) => Number(t.payload.inputTokens ?? 0)))
        : null,
      cacheHitRatio: turns.length ? 0.62 : null,
      compactions: [],
      contextSections: turns.length
        ? { soul: 820, memory: 240, knowledge: 410, thread: 1900 }
        : null,
      systemPromptSha256: turns.length
        ? "3f1c0d9e2b7a4c6d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d"
        : null,
      maxContextTokens: null,
      modelRequests: {
        count: turns.length,
        distinctSystemHashes: turns.length ? 1 : 0,
        changedWithinAttempt: false,
      },
    };
    return ok(metrics);
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/runs\/([^/]+)\/timeline$/))) {
    const run = s.runs.get(decodeURIComponent(x[1] ?? "") as RunId);
    if (!run) return notFound("run");
    // The demo records no timeline marks, so every process stage reads "not observed".
    return ok(
      buildRunTimeline({
        runId: run.id,
        status: run.status,
        attempt: run.attempt ?? 1,
        createdAt: run.createdAt,
        finishedAt: run.finishedAt ?? null,
        events: s.events.get(run.id) ?? [],
      }),
    );
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if (method === "POST" && (x = m(/^\/api\/runs\/([^/]+)\/cancel$/))) {
    const run = s.runs.get(decodeURIComponent(x[1] ?? "") as RunId);
    if (!run) return notFound("run");
    if (isTerminal(run.status))
      return {
        status: 409,
        json: { code: "invalid_transition", message: `run is ${run.status}`, details: {} },
      };
    // Only this run: its script stops at its next step (`DemoRunCancelled`), nothing else does.
    s.setStatus(run, "cancelled");
    return ok({ run: { ...run } });
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/runs\/([^/]+)\/continuation\/decide$/))) {
    const run = s.runs.get(decodeURIComponent(x[1] ?? "") as RunId);
    if (!run) return notFound("run");
    if (isTerminal(run.status))
      return {
        status: 409,
        json: { code: "invalid_transition", message: `run is ${run.status}`, details: {} },
      };
    s.setStatus(run, b.decision === "continue" ? "running" : "stopped");
    if (b.decision === "continue")
      void finishLater(
        s,
        run,
        2000,
        summary("Continued and finished the remaining steps."),
        "succeeded",
      ).catch(ignoreCancelled);
    return ok({ run });
  }
  return undefined;
}
