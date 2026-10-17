// T1: the offline startup-latency report (ADR-0037 decisions 3, 4 and 6). It reads a Gateway
// database read-only, derives each attempt's timeline, groups attempts by class and reports
// percentiles over observed stages only, with failure, retry and cache distributions.

import { type RunTimelineMark, timelineMark } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../packages/gateway/src/db/open.js";
import { parseArgs } from "./latency-report.js";
import { loadLatencyRuns } from "./latency/load.js";
import { percentile, renderLatencyMarkdown, summarizeLatency } from "./latency/metrics.js";

const T0 = Date.parse("2026-10-14T10:00:00.000Z");
const iso = (ms: number): string => new Date(T0 + ms).toISOString();

type Db = ReturnType<typeof openDatabase>;

function seedBase(db: Db): void {
  db.exec(
    "INSERT INTO workspaces (id, tenant_id,name,sandbox_provider,status,created_at) VALUES ('w', 'tnt_default','w','docker','ready','t');" +
      "INSERT INTO bots (id,name,role,workspace_id,created_at) VALUES ('b','nova','r','w','t');" +
      "INSERT INTO threads (id,workspace_id,kind,channel,title,turn_budget,status,created_at,updated_at) VALUES ('T','w','chat','web','t',8,'active','t','t');",
  );
}

let seq = 0;
function insertRun(
  db: Db,
  id: string,
  offset: number,
  status: string,
  opts: { attempt?: number; runType?: string; finishedAfter?: number } = {},
): void {
  db.prepare(
    "INSERT INTO thread_messages (id,thread_id,seq,author_kind,author_id,body,attachments_json,mentions_json,relay_count,run_id,ts) VALUES (?,'T',?,'human','web','hi','[]','[]',0,NULL,?)",
  ).run(`m-${id}`, ++seq, iso(offset));
  db.prepare(
    "INSERT INTO runs (workspace_id,id,bot_id,thread_id,lane,trigger_kind,trigger_ref,status,attempt,config_json,created_at,finished_at) VALUES ('w',?,'b','T','interactive','thread_message',?,?,?,?,?,?)",
  ).run(
    id,
    `m-${id}`,
    status,
    opts.attempt ?? 1,
    JSON.stringify(opts.runType ? { runType: opts.runType } : {}),
    iso(offset + 50),
    opts.finishedAfter === undefined ? null : iso(offset + opts.finishedAfter),
  );
}

const eventSeq = new Map<string, number>();
function event(
  db: Db,
  runId: string,
  kind: string,
  payload: Record<string, unknown>,
  at: number,
  attempt = 1,
): void {
  const next = (eventSeq.get(runId) ?? 0) + 1;
  eventSeq.set(runId, next);
  db.prepare(
    "INSERT INTO run_events (run_id,seq,attempt,kind,payload_json,ts) VALUES (?,?,?,?,?,?)",
  ).run(runId, next, attempt, kind, JSON.stringify(payload), iso(at));
}

function mark(
  db: Db,
  runId: string,
  name: RunTimelineMark,
  at: number,
  attrs: Record<string, unknown> = {},
  attempt = 1,
): void {
  event(db, runId, "log", timelineMark(name, new Date(T0 + at), attrs), at, attempt);
}

/** A full warm start whose first token arrives `tokenAt` ms after submission. */
function warmRun(db: Db, id: string, offset: number, tokenAt: number, retries = 0): void {
  insertRun(db, id, offset, "succeeded", { finishedAfter: tokenAt + 1000 });
  mark(db, id, "attempt_started", offset + 100, { start: "fresh", session: "resumed" });
  mark(db, id, "sandbox_ready", offset + 120, { sandbox: "cached" });
  mark(db, id, "sidecar_spawned", offset + 130);
  mark(db, id, "sdk_init", offset + 900);
  for (let i = 0; i < retries; i++) event(db, id, "model_retry", { attempt: i + 1 }, offset + 950);
  event(
    db,
    id,
    "log",
    { source: "phase_timing", phase: "model_request", edge: "start", at: iso(offset + 1000) },
    offset + 1000,
  );
  mark(db, id, "first_token", offset + tokenAt);
  mark(db, id, "first_text", offset + tokenAt + 50);
  event(
    db,
    id,
    "turn_usage",
    {
      turn: 1,
      model: "m",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 990,
      cacheCreateTokens: 0,
    },
    offset + tokenAt + 60,
  );
  mark(db, id, "run_ended", offset + tokenAt + 1000, { outcome: "completed", replyPosted: true });
  mark(db, id, "attempt_closed", offset + tokenAt + 1100, { spawned: true, exitCode: 0 });
}

function seeded(): Db {
  const db = openDatabase(":memory:");
  seedBase(db);
  warmRun(db, "r1", 0, 2000);
  warmRun(db, "r2", 10_000, 3000);
  warmRun(db, "r3", 20_000, 4000, 2);
  // A cold start that failed before the SDK came up: no token, no text.
  insertRun(db, "r4", 30_000, "failed", { finishedAfter: 40_000 });
  mark(db, "r4", "attempt_started", 30_100, { start: "fresh", session: "new" });
  mark(db, "r4", "sandbox_ready", 65_000, { sandbox: "created" });
  mark(db, "r4", "sidecar_spawned", 65_010);
  mark(db, "r4", "attempt_closed", 70_000, { spawned: true, exitCode: 1 });
  // A run from before ADR-0037 and a summary job.
  insertRun(db, "r5", 40_000, "succeeded", { finishedAfter: 5000 });
  insertRun(db, "r6", 50_000, "succeeded", { runType: "activity_summary", finishedAfter: 900 });
  mark(db, "r6", "attempt_started", 50_100, { start: "fresh", session: "new" });
  return db;
}

describe("latency report", () => {
  it("reports percentiles per class over observed stages only", () => {
    const db = seeded();
    try {
      const summary = summarizeLatency(loadLatencyRuns(db));
      expect(summary.runs).toBe(5);
      expect(summary.runsWithoutMarks).toBe(1);
      expect(summary.attempts).toBe(4);
      expect(summary.classes.map((c) => [c.key, c.attempts])).toEqual([
        ["fresh / session-new / sandbox-created / no-retry", 1],
        ["fresh / session-resumed / sandbox-cached / no-retry", 2],
        ["fresh / session-resumed / sandbox-cached / retried", 1],
      ]);
      const warm = summary.classes[1];
      expect(warm?.metrics.ttft).toEqual({ observed: 2, missing: 0, p50: 2000, p95: 3000 });
      expect(warm?.metrics.firstRequest.p50).toBe(1000);
      expect(warm?.metrics.firstVisible).toMatchObject({ observed: 2, p50: 3000, p95: 4000 });
      const cold = summary.classes[0];
      expect(cold?.metrics.ttft).toEqual({ observed: 0, missing: 1, p50: null, p95: null });
      expect(cold?.metrics.e2e).toMatchObject({ observed: 1, p50: 40_000 });
      expect(summary.retries).toEqual({ "0": 3, "2": 1 });
      expect(summary.outcomes).toEqual({ completed: 3, closed: 1 });
      expect(summary.firstTurnCacheRead).toEqual({ ">=90%": 3, unknown: 1 });

      const md = renderLatencyMarkdown(summary, "test.sqlite");
      expect(md).toContain("| ttft | 2 | 0 | 2000 | 3000 |");
      expect(md).toContain("| ttft | 0 | 1 | – | – |");
      expect(md).toContain("clocks may differ");
      expect(md).toContain("not quality evidence");
    } finally {
      db.close();
    }
  });

  it("includes jobs only on request and filters by creation time", () => {
    const db = seeded();
    try {
      expect(summarizeLatency(loadLatencyRuns(db), { includeJobs: true }).attempts).toBe(5);
      const later = summarizeLatency(loadLatencyRuns(db, iso(25_000)));
      expect(later.runs).toBe(2);
      expect(later.attempts).toBe(1);
    } finally {
      db.close();
    }
  });

  it("uses nearest-rank percentiles and parses its arguments", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5, 1, 3], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(parseArgs(["--db", "x.sqlite", "--since", "2026-10-01", "--jobs", "--json"])).toEqual({
      db: "x.sqlite",
      since: "2026-10-01",
      jobs: true,
      json: true,
    });
    expect(() => parseArgs(["--bogus"])).toThrow("unknown argument");
  });
});
