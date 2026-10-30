// T1, ADR-0046 decision 3, run against every sink this release bundles: the schema step is
// idempotent, a batch commits every table under its token, a replayed batch is a no-op, a batch
// committed halfway completes on resend without doubling, and `lastCommitted` is the newest
// batch. The loader admits only the bundled entry points, and the config accepts exactly their
// ids.

import { join } from "node:path";
import {
  OBSERVABILITY_CONTRACT_VERSION,
  OBSERVABILITY_TABLES,
  OBSERVABILITY_TABLE_COLUMNS,
  type ObservabilityBatch,
  type ObservabilityRow,
  type ObservabilitySinkRuntime,
  type ObservabilityTable,
  observabilityCommitToken,
} from "@deskmates/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { OBSERVABILITY_SINK_IDS, type ObservabilitySettings } from "../config/observability.js";
import { tempDir } from "../test-support/observability-ledger.js";
import { BUNDLED_SINKS, loadSink } from "./sinks.js";

const tmp = tempDir("obs-contract");
afterAll(() => tmp.remove());

let n = 0;
function settingsFor(id: string): ObservabilitySettings {
  n++;
  return {
    sink: id as ObservabilitySettings["sink"],
    sqlitePath: join(tmp.dir, `contract-${n}.sqlite`),
    batchSeconds: 300,
    batchBytes: 1 << 20,
    payloads: "full",
    retrospective: true,
  };
}

function row(table: ObservabilityTable, i: number): ObservabilityRow {
  return OBSERVABILITY_TABLE_COLUMNS[table].map(([name, type]) =>
    type === "text" ? `${name}-${i}` : i,
  );
}

function batch(id: string, rows = 3): ObservabilityBatch {
  const tables: ObservabilityBatch["tables"] = {};
  const sources: ObservabilityBatch["sources"] = {};
  for (const table of OBSERVABILITY_TABLES) {
    tables[table] = Array.from({ length: rows }, (_, i) => row(table, i));
    sources[table] = { first: null, last: String(rows) };
  }
  return {
    contractVersion: OBSERVABILITY_CONTRACT_VERSION,
    batchId: id,
    openedAt: "2026-10-17T00:00:00.000Z",
    closedAt: "2026-10-17T00:05:00.000Z",
    tables,
    sources,
  };
}

/** Rows a sink holds per table, read back through its own engine where it has one. */
type Counter = (
  sink: ObservabilitySinkRuntime,
  settings: ObservabilitySettings,
) => Promise<Record<string, number>>;

const counters: Record<string, Counter> = {
  sqlite: async (_sink, settings) => {
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(settings.sqlitePath as string, { readonly: true });
    try {
      return Object.fromEntries(
        [...OBSERVABILITY_TABLES, "ingest_batches"].map((t) => [
          t,
          (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n,
        ]),
      );
    } finally {
      db.close();
    }
  },
};

describe("the observability sink loader (ADR-0046 decision 3)", () => {
  it("bundles exactly the sinks the configuration accepts", () => {
    expect(Object.keys(BUNDLED_SINKS).sort()).toEqual([...OBSERVABILITY_SINK_IDS].sort());
    expect(Object.keys(counters).sort()).toEqual(Object.keys(BUNDLED_SINKS).sort());
  });

  it("refuses an id that is not a bundled entry point, whatever it looks like", () => {
    for (const id of [
      "postgres",
      "forward",
      "../sqlite",
      "constructor",
      "__proto__",
      "./sqlite.js",
    ])
      expect(() => loadSink({ settings: settingsFor(id), dbPath: ":memory:" }), id).toThrow(
        "not bundled",
      );
  });
});

for (const id of Object.keys(BUNDLED_SINKS))
  describe(`sink contract: ${id}`, () => {
    const open = () => {
      const settings = settingsFor(id);
      const sink = loadSink({ settings, dbPath: ":memory:" });
      return { sink, settings, count: () => (counters[id] as Counter)(sink, settings) };
    };

    it("declares itself under its id and the current contract version", () => {
      const { sink } = open();
      expect(sink.manifest.id).toBe(id);
      expect(sink.manifest.contractVersion).toBe(OBSERVABILITY_CONTRACT_VERSION);
    });

    it("prepares its schema idempotently and commits every table under its token", async () => {
      const { sink, count } = open();
      await sink.ensureSchema();
      await sink.ensureSchema();
      expect(await sink.lastCommitted()).toBeNull();
      const result = await sink.writeBatch(batch("000000000001"));
      expect(result.committed.sort()).toEqual(
        OBSERVABILITY_TABLES.map((t) => observabilityCommitToken(t, "000000000001")).sort(),
      );
      const counts = await count();
      for (const table of OBSERVABILITY_TABLES) expect(counts[table], table).toBe(3);
      expect(await sink.lastCommitted()).toBe("000000000001");
      await sink.close();
    });

    it("treats a replayed batch as a no-op that still reports its tokens committed", async () => {
      const { sink, count } = open();
      await sink.ensureSchema();
      const first = await sink.writeBatch(batch("000000000001"));
      const before = await count();
      const again = await sink.writeBatch(batch("000000000001"));
      expect(again.committed.sort()).toEqual(first.committed.sort());
      expect(await count()).toEqual(before);
      await sink.writeBatch(batch("000000000002", 2));
      expect(await sink.lastCommitted()).toBe("000000000002");
      expect((await count()).run_events).toBe(5);
      await sink.close();
    });

    it("completes a batch committed halfway, without doubling the tables already in", async () => {
      const { sink, count } = open();
      await sink.ensureSchema();
      const half = batch("000000000001");
      const partial: ObservabilityBatch = {
        ...half,
        tables: { run_events: half.tables.run_events ?? [] },
      };
      await sink.writeBatch(partial);
      await sink.writeBatch(half);
      const counts = await count();
      for (const table of OBSERVABILITY_TABLES) expect(counts[table], table).toBe(3);
      expect(counts.ingest_batches).toBe(OBSERVABILITY_TABLES.length);
      await sink.close();
    });
  });
