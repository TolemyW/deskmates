// T1, ADR-0046 decision 2: the collector spools a ledger row before its received watermark moves
// and commits it before its committed watermark moves, so a kill at any step (spool, batch close,
// commit, between two tables of a batch, a torn spool write) loses and duplicates nothing once a
// fresh collector has recovered from disk. Events are read before ledger retention prunes them,
// and a prune afterwards changes nothing the sink holds. Fake sink, real ledger, no Docker.

import { appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pruneRunLedger } from "../ledger/run-retention.js";
import type { Harness } from "../test-support/harness.js";
import {
  type Ctx,
  LATER,
  column,
  exactlyOnceProblems,
  fakeSink,
  ledgerHarness,
  seedRun,
  tempDir,
} from "../test-support/observability-ledger.js";
import { Collector } from "./collector.js";
import type { CrashPoint } from "./spool.js";

let h: Harness | undefined;
const cleanup: Array<() => void> = [];
afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const c of cleanup.splice(0)) c();
});

const SETTINGS = { batchSeconds: 300, batchBytes: 64 * 1024 * 1024, payloads: "full" as const };

class Killed extends Error {}

async function setup() {
  const l = await ledgerHarness();
  h = l.h;
  const spool = tempDir("obs-spool");
  cleanup.push(spool.remove);
  return { ...l, spoolDir: spool.dir };
}

function collector(
  ctx: Ctx,
  spoolDir: string,
  sink: ReturnType<typeof fakeSink>,
  fault?: (p: CrashPoint) => void,
  settings = SETTINGS,
) {
  return new Collector({
    db: ctx.db,
    sink,
    spoolDir,
    settings,
    now: LATER,
    ...(fault ? { fault } : {}),
  });
}

/** Read, close and commit everything there is, as a restart followed by a flush would. */
async function drain(c: Collector) {
  await c.init();
  await c.tick();
  c.closeOpen();
  await c.tick();
}

const once = (point: CrashPoint) => {
  let fired = false;
  return (p: CrashPoint) => {
    if (p === point && !fired) {
      fired = true;
      throw new Killed(point);
    }
  };
};

/** Changes after the crash: a new run, a status change, a mark and an unmark, a renamed bot. */
function moreLedger(ctx: Ctx, ids: { botId: string; threadId: string; workspaceId: string }) {
  const first = (
    ctx.db.prepare("SELECT id FROM runs ORDER BY created_at LIMIT 1").get() as {
      id: string;
    }
  ).id;
  seedRun(ctx, ids, "failed");
  ctx.db
    .prepare("UPDATE runs SET status = 'succeeded', finished_at = ? WHERE status = 'running'")
    .run(new Date().toISOString());
  ctx.db
    .prepare(
      "INSERT INTO run_marks (run_id, workspace_id, verdict, marked_by, marked_at) VALUES (?, ?, 'wrong', 'user:u1', ?)",
    )
    .run(first, ids.workspaceId, new Date().toISOString());
  ctx.db.prepare("UPDATE bots SET role = 'renamed role' WHERE id = ?").run(ids.botId);
}

const POINTS: CrashPoint[] = [
  "spool.beforeWrite",
  "spool.afterWrite",
  "close.beforeRename",
  "close.afterRename",
  "commit.afterSink",
  "commit.afterState",
];

describe("collector crash safety (ADR-0046 decision 2)", () => {
  it("collects every table of a seeded ledger exactly once", async () => {
    const { ctx, spoolDir, ...ids } = await setup();
    seedRun(ctx, ids);
    seedRun(ctx, ids, "running");
    const sink = fakeSink();
    await drain(collector(ctx, spoolDir, sink));
    expect(exactlyOnceProblems(ctx, sink.rows)).toEqual([]);
    for (const table of Object.keys(sink.rows) as Array<keyof typeof sink.rows>)
      if (table !== "run_marks") expect(sink.rows[table].length, table).toBeGreaterThan(0);
    // The spool holds only `committed.json` once everything is committed.
    expect(readdirSync(spoolDir)).toEqual(["committed.json"]);
  });

  for (const point of POINTS)
    it(`a kill at ${point} loses and duplicates nothing`, async () => {
      const { ctx, spoolDir, ...ids } = await setup();
      seedRun(ctx, ids);
      seedRun(ctx, ids, "running");
      const sink = fakeSink();
      await expect(drain(collector(ctx, spoolDir, sink, once(point)))).rejects.toBeInstanceOf(
        Killed,
      );
      moreLedger(ctx, ids);
      await drain(collector(ctx, spoolDir, sink));
      expect(exactlyOnceProblems(ctx, sink.rows)).toEqual([]);
      const marks = column(sink.rows, "run_marks", "verdict");
      expect(marks).toEqual(["wrong"]);
    });

  it("a sink that fails between two tables of a batch gets the batch again; nothing doubles", async () => {
    const { ctx, spoolDir, ...ids } = await setup();
    seedRun(ctx, ids);
    const sink = fakeSink({ failAfterTables: 2 });
    await expect(drain(collector(ctx, spoolDir, sink))).rejects.toThrow("between tables");
    expect(sink.tokens.size).toBe(2);
    await drain(collector(ctx, spoolDir, sink));
    expect(exactlyOnceProblems(ctx, sink.rows)).toEqual([]);
    expect(sink.writes).toBe(2);
  });

  it("a torn spool write is cut off at the last complete chunk", async () => {
    const { ctx, spoolDir, ...ids } = await setup();
    seedRun(ctx, ids);
    const sink = fakeSink();
    const first = collector(ctx, spoolDir, sink);
    await first.init();
    await first.tick(); // one chunk in the open batch, nothing closed
    const open = readdirSync(spoolDir).find((n) => n.endsWith(".open.jsonl"));
    expect(open).toBeDefined();
    // The process died halfway through writing the next chunk.
    appendFileSync(join(spoolDir, open as string), '{"t":"run_events","r":[999999,"run_x"');
    moreLedger(ctx, ids);
    await drain(collector(ctx, spoolDir, sink));
    expect(exactlyOnceProblems(ctx, sink.rows)).toEqual([]);
    expect(column(sink.rows, "run_events", "event_id")).not.toContain(999999);
  });

  it("the received watermark moves only with spooled rows, the committed one only with a commit", async () => {
    const { ctx, spoolDir, ...ids } = await setup();
    seedRun(ctx, ids);
    const sink = fakeSink();
    const c = collector(ctx, spoolDir, sink);
    await c.init();
    const events = () => c.tables().find((t) => t.table === "run_events");
    expect(events()).toEqual({ table: "run_events", received: null, committed: null });
    await c.tick();
    const lastId = (ctx.db.prepare("SELECT max(id) AS id FROM run_events").get() as { id: number })
      .id;
    expect(events()).toEqual({ table: "run_events", received: String(lastId), committed: null });
    expect(sink.rows.run_events).toEqual([]);
    c.closeOpen();
    await c.tick();
    expect(events()).toEqual({
      table: "run_events",
      received: String(lastId),
      committed: String(lastId),
    });
  });

  it("closes a batch by age and by size", async () => {
    const { ctx, spoolDir, ...ids } = await setup();
    seedRun(ctx, ids);
    let now = LATER();
    const sink = fakeSink();
    const byAge = new Collector({
      db: ctx.db,
      sink,
      spoolDir,
      settings: { ...SETTINGS, batchSeconds: 60 },
      now: () => now,
    });
    await byAge.init();
    await byAge.tick();
    expect(sink.writes).toBe(0);
    now = new Date(now.getTime() + 61_000);
    await byAge.tick();
    expect(sink.writes).toBe(1);

    seedRun(ctx, ids);
    const bySize = new Collector({
      db: ctx.db,
      sink,
      spoolDir,
      settings: { ...SETTINGS, batchBytes: 1 },
      now: () => new Date(now.getTime() + 60_000),
    });
    await bySize.init();
    await bySize.tick();
    expect(sink.writes).toBe(2);
    expect(exactlyOnceProblems(ctx, sink.rows)).toEqual([]);
  });

  it("reads events before ledger retention prunes them; a later prune changes nothing in the sink", async () => {
    const { ctx, spoolDir, ...ids } = await setup();
    const old = seedRun(ctx, ids);
    const sink = fakeSink();
    await drain(collector(ctx, spoolDir, sink));
    const held = sink.rows.run_events.length;
    expect(held).toBeGreaterThan(0);
    ctx.db
      .prepare(
        "UPDATE runs SET created_at = @at, started_at = @at, finished_at = @at WHERE id = @id",
      )
      .run({ at: "2026-01-01T00:00:00.000Z", id: old });
    const pruned = pruneRunLedger(ctx.db, 30, new Date("2026-10-15T00:00:00.000Z"));
    expect(pruned.events).toBeGreaterThan(0);
    seedRun(ctx, ids);
    await drain(collector(ctx, spoolDir, sink));
    // The pruned run's events stay in the sink; the new run's events arrive; nothing doubles.
    expect(column(sink.rows, "run_events", "run_id").filter((r) => r === old)).toHaveLength(held);
    expect(sink.rows.run_events.length).toBeGreaterThan(held);
    const ids2 = column(sink.rows, "run_events", "event_id");
    expect(new Set(ids2).size).toBe(ids2.length);
  });

  it("refuses a sink that is ahead of a lost spool instead of reading the ledger twice", async () => {
    const { ctx, spoolDir, ...ids } = await setup();
    seedRun(ctx, ids);
    const sink = fakeSink();
    await drain(collector(ctx, spoolDir, sink));
    const lost = tempDir("obs-spool-lost");
    cleanup.push(lost.remove);
    await expect(collector(ctx, lost.dir, sink).init()).rejects.toThrow("does not know");
  });

  it("holds back a model request until its usage lands, without holding back the next one", async () => {
    const { ctx, spoolDir, ...ids } = await setup();
    const live = seedRun(ctx, ids, "running");
    const pending = ctx.modelRequests.insert({
      runId: live,
      attempt: 1,
      ts: new Date().toISOString(),
      requestKind: "messages",
      model: "model-a",
      stream: true,
    });
    const done = ctx.modelRequests.insert({
      runId: live,
      attempt: 1,
      ts: new Date().toISOString(),
      requestKind: "messages",
      model: "model-a",
      stream: true,
    });
    ctx.modelRequests.setUsage(done, { inputTokens: 7, outputTokens: 1 });
    const sink = fakeSink();
    await drain(collector(ctx, spoolDir, sink));
    expect(column(sink.rows, "model_requests", "request_id")).not.toContain(pending);
    expect(column(sink.rows, "model_requests", "request_id")).toContain(done);
    ctx.modelRequests.setUsage(pending, { inputTokens: 9, outputTokens: 2 });
    await drain(collector(ctx, spoolDir, sink));
    const requests = column(sink.rows, "model_requests", "request_id");
    expect(requests.filter((id) => id === pending)).toHaveLength(1);
    expect(requests.filter((id) => id === done)).toHaveLength(1);
    const input = column(sink.rows, "model_requests", "input_tokens");
    expect(input[requests.indexOf(pending)]).toBe(9);
  });
});
