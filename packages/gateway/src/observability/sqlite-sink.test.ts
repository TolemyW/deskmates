// T1, ADR-0046 decision 4: the `sqlite` sink writes `obs.sqlite`, a separate WAL file beside the
// ledger; one transaction per table per batch (a failure between tables leaves the earlier
// tables committed and the rest not, and a resend completes them); retention by days removes old
// rows but keeps the newest snapshot of every bot, workspace, thread, task and live run; a file
// of another contract version is refused; and the ledger file is untouched by any of it.

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  OBSERVABILITY_CONTRACT_VERSION,
  OBSERVABILITY_TABLE_COLUMNS,
  type ObservabilityBatch,
  type ObservabilityRow,
  type ObservabilityTable,
} from "@deskmates/contracts";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { testConfig } from "../test-support/harness.js";
import { LATER, ledgerHarness, seedRun, tempDir } from "../test-support/observability-ledger.js";
import { createObservabilityModule } from "./observability-module.js";
import { createSqliteSink } from "./sqlite-sink.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});

function dir() {
  const t = tempDir("obs-sqlite");
  cleanup.push(t.remove);
  return t.dir;
}

function rowOf(table: ObservabilityTable, values: Record<string, unknown>): ObservabilityRow {
  return OBSERVABILITY_TABLE_COLUMNS[table].map(
    ([name]) => (values[name] ?? null) as string | number | null,
  );
}

function batch(
  id: string,
  closedAt: string,
  tables: ObservabilityBatch["tables"],
): ObservabilityBatch {
  return {
    contractVersion: OBSERVABILITY_CONTRACT_VERSION,
    batchId: id,
    openedAt: closedAt,
    closedAt,
    tables,
    sources: {},
  };
}

const count = (db: Database.Database, table: string) =>
  (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("the sqlite observability sink (ADR-0046 decision 4)", () => {
  it("writes obs.sqlite beside the ledger in WAL mode, and never touches the ledger", async () => {
    const root = dir();
    const l = await ledgerHarness();
    try {
      const ledgerSchema = () =>
        l.ctx.db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all();
      seedRun(l.ctx, l);
      const before = ledgerSchema();
      const rowsBefore = count(l.ctx.db, "run_events");
      // `dbPath` places the files; the module reads the harness's ledger connection.
      const config = testConfig({
        dbPath: join(root, "gateway.sqlite"),
        observability: {
          sink: "sqlite",
          batchSeconds: 300,
          batchBytes: 1 << 20,
          payloads: "full",
          retrospective: true,
        },
      });
      const module = createObservabilityModule({ db: l.ctx.db, config, now: LATER });
      if (!module) throw new Error("module not created");
      await module.flush();
      await module.stop();
      const obsPath = join(root, "obs.sqlite");
      expect(existsSync(obsPath)).toBe(true);
      expect(existsSync(join(root, "observability-spool", "committed.json"))).toBe(true);
      const obs = new Database(obsPath, { readonly: true });
      expect(obs.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(count(obs, "run_events")).toBe(rowsBefore);
      expect(count(obs, "runs_named")).toBe(1);
      obs.close();
      expect(ledgerSchema()).toEqual(before);
      expect(count(l.ctx.db, "run_events")).toBe(rowsBefore);
      for (const name of ["ingest_batches", "run_states", "approval_decisions"])
        expect(
          l.ctx.db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name),
          name,
        ).toBeUndefined();
    } finally {
      await l.h.close();
    }
  });

  it("commits one table per transaction: a failure between tables keeps the first and resends the rest", async () => {
    const path = join(dir(), "obs.sqlite");
    let fail = true;
    const sink = createSqliteSink({
      path,
      beforeTable: (table) => {
        if (table === "run_states" && fail) {
          fail = false;
          throw new Error("killed between tables");
        }
      },
    });
    await sink.ensureSchema();
    const b = batch("000000000001", "2026-10-17T00:00:00.000Z", {
      run_events: [rowOf("run_events", { event_id: 1 }), rowOf("run_events", { event_id: 2 })],
      run_states: [rowOf("run_states", { run_id: "run_a", status: "running" })],
    });
    await expect(sink.writeBatch(b)).rejects.toThrow("between tables");
    const db = new Database(path, { readonly: true });
    expect(count(db, "run_events")).toBe(2);
    expect(count(db, "run_states")).toBe(0);
    expect(count(db, "ingest_batches")).toBe(1);
    const again = await sink.writeBatch(b);
    expect(again.committed).toEqual(["obs/run_events/000000000001", "obs/run_states/000000000001"]);
    expect(count(db, "run_events")).toBe(2);
    expect(count(db, "run_states")).toBe(1);
    db.close();
    await sink.close();
  });

  it("prunes by days but keeps the newest snapshot of every key and of every live run", async () => {
    const path = join(dir(), "obs.sqlite");
    let now = new Date("2026-10-17T00:00:00.000Z");
    const sink = createSqliteSink({ path, retentionDays: 7, now: () => now });
    await sink.ensureSchema();
    const old = "2026-10-01T00:00:00.000Z";
    await sink.writeBatch(
      batch("000000000001", old, {
        run_events: [rowOf("run_events", { event_id: 1, run_id: "run_done" })],
        run_states: [
          rowOf("run_states", { run_id: "run_done", status: "succeeded", terminal: 1 }),
          rowOf("run_states", {
            run_id: "run_live",
            status: "running",
            terminal: 0,
            observed_at: "a",
          }),
          rowOf("run_states", {
            run_id: "run_live",
            status: "waiting_approval",
            terminal: 0,
            observed_at: "b",
          }),
        ],
        bot_states: [
          rowOf("bot_states", { bot_id: "bot_a", name: "old name", observed_at: "a" }),
          rowOf("bot_states", { bot_id: "bot_a", name: "kept name", observed_at: "b" }),
        ],
      }),
    );
    // The commit ran a prune pass: the old run's event, its terminal run, the superseded
    // snapshots of the live run and the bot.
    expect((await sink.stats?.())?.lastPrune?.rows).toBe(4);
    // An hour later the next commit prunes again, and the old batch's tokens go.
    now = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    await sink.writeBatch(
      batch("000000000002", now.toISOString(), {
        run_events: [rowOf("run_events", { event_id: 2, run_id: "run_new" })],
      }),
    );
    const db = new Database(path, { readonly: true });
    expect(db.prepare("SELECT event_id FROM run_events").all()).toEqual([{ event_id: 2 }]);
    expect(db.prepare("SELECT run_id, status FROM run_states").all()).toEqual([
      { run_id: "run_live", status: "waiting_approval" },
    ]);
    expect(db.prepare("SELECT name FROM bot_states").all()).toEqual([{ name: "kept name" }]);
    // The newest batch keeps its tokens; the old one's go.
    expect(db.prepare("SELECT DISTINCT batch_id FROM ingest_batches").all()).toEqual([
      { batch_id: "000000000002" },
    ]);
    expect((await sink.stats?.())?.lastPrune?.rows).toBe(0);
    db.close();
    await sink.close();
  });

  it("keeps everything without a retention setting", async () => {
    const path = join(dir(), "obs.sqlite");
    const sink = createSqliteSink({ path, now: () => new Date("2027-01-01T00:00:00.000Z") });
    await sink.ensureSchema();
    await sink.writeBatch(
      batch("000000000001", "2020-01-01T00:00:00.000Z", {
        run_events: [rowOf("run_events", { event_id: 1 })],
      }),
    );
    const db = new Database(path, { readonly: true });
    expect(count(db, "run_events")).toBe(1);
    db.close();
    await sink.close();
  });

  it("refuses a file written under another contract version", async () => {
    const path = join(dir(), "obs.sqlite");
    const first = createSqliteSink({ path });
    await first.ensureSchema();
    await first.close();
    const raw = new Database(path);
    raw.pragma("user_version = 99");
    raw.close();
    const second = createSqliteSink({ path });
    await expect(second.ensureSchema()).rejects.toThrow("contract version 99");
    await second.close();
  });

  // ADR-0046 amendment 2 decision 22: version 2 only added tables, so a version 1 file is
  // upgraded in place with its rows kept; version 3 is still refused.
  it("upgrades a version 1 file in place and refuses version 3", async () => {
    const path = join(dir(), "obs.sqlite");
    const first = createSqliteSink({ path });
    await first.ensureSchema();
    await first.writeBatch(
      batch("b000001", "2026-10-01T00:00:00.000Z", {
        run_states: [rowOf("run_states", { run_id: "run_old", status: "succeeded" })],
      }),
    );
    await first.close();
    const raw = new Database(path);
    for (const table of [
      "approval_requests",
      "run_vectors",
      "retrospective_matches",
      "retrospective_state",
    ])
      raw.exec(`DROP TABLE ${table}`);
    raw.exec("DROP VIEW failure_matches; DROP VIEW approval_requests_named");
    raw.pragma("user_version = 1");
    raw.close();

    const upgraded = createSqliteSink({ path });
    await upgraded.ensureSchema();
    await upgraded.close();
    const check = new Database(path, { readonly: true });
    expect(check.pragma("user_version", { simple: true })).toBe(OBSERVABILITY_CONTRACT_VERSION);
    expect(count(check, "run_states")).toBe(1);
    expect(count(check, "approval_requests")).toBe(0);
    expect(count(check, "run_vectors")).toBe(0);
    check.close();

    const later = new Database(path);
    later.pragma("user_version = 3");
    later.close();
    const refused = createSqliteSink({ path });
    await expect(refused.ensureSchema()).rejects.toThrow("contract version 3");
    await refused.close();
  });
});

describe("the sqlite sink's vector store (ADR-0046 amendment 2 decision 23)", () => {
  const vector = (...values: number[]) => {
    const v = Float32Array.from(values);
    const norm = Math.hypot(...values);
    return v.map((x) => x / norm);
  };
  const row = (runId: string, outcome: "succeeded" | "failed", values: number[], at: string) => ({
    runId,
    sourceVersion: `a1-${outcome}`,
    workspaceId: "ws_1",
    outcome,
    failureClass: outcome === "failed" ? "model_unavailable" : null,
    embeddingModel: "embed-test",
    vector: vector(...values),
    finishedAt: at,
    embeddedAt: at,
  });

  it("declares vectors and stores them as float32 BLOBs, one per run and model", async () => {
    const path = join(dir(), "obs.sqlite");
    const sink = createSqliteSink({ path });
    await sink.ensureSchema();
    expect(sink.manifest.capabilities.vectors).toBe(true);
    const store = sink.vectors;
    if (!store) throw new Error("no vector store");
    const at = "2026-10-18T00:00:00.000Z";
    await store.putVectors([
      row("run_ok", "succeeded", [1, 0, 0], at),
      row("run_bad", "failed", [0, 1, 0], at),
    ]);
    // A newer source version replaces the run's row.
    await store.putVectors([
      { ...row("run_ok", "succeeded", [0, 0, 1], at), sourceVersion: "a2-succeeded" },
    ]);
    expect(await store.embeddedVersions("embed-test", ["run_ok", "run_bad", "run_none"])).toEqual(
      new Map([
        ["run_ok", "a2-succeeded"],
        ["run_bad", "a1-failed"],
      ]),
    );
    expect(await store.embeddedVersions("another-model", ["run_ok"])).toEqual(new Map());
    const succeeded = await store.succeeded("ws_1", "embed-test");
    expect(succeeded.map((s) => s.runId)).toEqual(["run_ok"]);
    expect([...(succeeded[0]?.vector ?? [])]).toEqual([0, 0, 1]);
    expect(await store.succeeded("ws_2", "embed-test")).toEqual([]);

    const failed = {
      runId: "run_bad",
      sourceVersion: "a1-failed",
      workspaceId: "ws_1",
      embeddingModel: "embed-test",
      computedAt: at,
    };
    await store.putMatches(failed, [{ matchRunId: "run_ok", rank: 1, similarity: 0.5 }]);
    await store.putMatches(failed, [{ matchRunId: "run_ok", rank: 1, similarity: 0.25 }]);
    expect(await store.cursor()).toBeNull();
    await store.setCursor({ at, id: "run_bad" });
    expect(await store.cursor()).toEqual({ at, id: "run_bad" });
    await sink.close();

    const raw = new Database(path, { readonly: true });
    const blob = raw
      .prepare("SELECT dims, length(vector) AS bytes FROM run_vectors WHERE run_id = 'run_ok'")
      .get() as { dims: number; bytes: number };
    expect(blob).toEqual({ dims: 3, bytes: 12 });
    expect(
      raw.prepare("SELECT rank, match_run_id, similarity FROM retrospective_matches").all(),
    ).toEqual([{ rank: 1, match_run_id: "run_ok", similarity: 0.25 }]);
    raw.close();
  });

  it("prunes the vectors and matches of runs retention removed, never fresh ones", async () => {
    const path = join(dir(), "obs.sqlite");
    let clock = new Date("2026-10-01T00:00:00.000Z");
    const sink = createSqliteSink({ path, retentionDays: 7, now: () => clock });
    await sink.ensureSchema();
    const store = sink.vectors;
    if (!store) throw new Error("no vector store");
    await sink.writeBatch(
      batch("b000001", "2026-10-01T00:00:00.000Z", {
        run_states: [rowOf("run_states", { run_id: "run_old", status: "succeeded", terminal: 1 })],
      }),
    );
    await store.putVectors([row("run_old", "succeeded", [1, 0], "2026-10-01T00:00:00.000Z")]);
    clock = new Date("2026-10-20T00:00:00.000Z");
    // Written now, for a run whose first snapshot has not reached the file yet.
    await store.putVectors([row("run_new", "failed", [0, 1], clock.toISOString())]);
    await sink.writeBatch(
      batch("b000002", clock.toISOString(), {
        task_runs: [rowOf("task_runs", { task_id: "t", run_id: "x" })],
      }),
    );
    await sink.close();
    const raw = new Database(path, { readonly: true });
    expect(
      (
        raw.prepare("SELECT run_id FROM run_vectors ORDER BY run_id").all() as { run_id: string }[]
      ).map((r) => r.run_id),
    ).toEqual(["run_new"]);
    raw.close();
  });
});
