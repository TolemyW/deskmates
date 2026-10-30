// T0, ADR-0046 decision 1: the SQLite sink's tables have exactly the columns the contract
// declares (after `batch_id`), in that order; `ingest_batches` has the commit-record columns; the
// views are exactly the contract's list, and each one compiles against the tables.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OBSERVABILITY_INGEST_COLUMNS,
  OBSERVABILITY_TABLES,
  OBSERVABILITY_TABLE_COLUMNS,
  OBSERVABILITY_VECTOR_TABLE_COLUMNS,
  OBSERVABILITY_VIEWS,
  type ObservabilityVectorTable,
} from "@deskmates/contracts";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { tempDir } from "../test-support/observability-ledger.js";
import { SQLITE_SCHEMA_PATH, createSqliteSink } from "./sqlite-sink.js";

const tmp = tempDir("obs-model");
afterAll(() => tmp.remove());

const path = join(tmp.dir, "obs.sqlite");
const ready = (async () => {
  const sink = createSqliteSink({ path });
  await sink.ensureSchema();
  await sink.close();
  return new Database(path, { readonly: true });
})();

const SQL_TYPE = { text: "TEXT", integer: "INTEGER", real: "REAL", blob: "BLOB" } as const;
const VECTOR_TABLES = Object.keys(OBSERVABILITY_VECTOR_TABLE_COLUMNS) as ObservabilityVectorTable[];

describe("the obs model in SQLite (ADR-0046 decision 1)", () => {
  for (const table of OBSERVABILITY_TABLES)
    it(`${table} has batch_id and the contract's columns, in order and with their types`, async () => {
      const db = await ready;
      const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string;
        type: string;
      }>;
      expect(info.map((c) => [c.name, c.type])).toEqual([
        ["batch_id", "TEXT"],
        ...OBSERVABILITY_TABLE_COLUMNS[table].map(([name, type]) => [name, SQL_TYPE[type]]),
      ]);
    });

  // Amendment 2 decision 23: the retrospective's tables, written by no batch, have no batch_id.
  for (const table of VECTOR_TABLES)
    it(`${table} has the contract's columns, in order and with their types`, async () => {
      const db = await ready;
      const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string;
        type: string;
      }>;
      expect(info.map((c) => [c.name, c.type])).toEqual(
        OBSERVABILITY_VECTOR_TABLE_COLUMNS[table].map(([name, type]) => [name, SQL_TYPE[type]]),
      );
    });

  it("ingest_batches has the commit-record columns and a unique token", async () => {
    const db = await ready;
    const info = db.prepare("PRAGMA table_info(ingest_batches)").all() as Array<{
      name: string;
    }>;
    expect(info.map((c) => c.name)).toEqual(OBSERVABILITY_INGEST_COLUMNS.map(([name]) => name));
    const unique = db.prepare("PRAGMA index_list(ingest_batches)").all() as Array<{
      name: string;
      unique: number;
    }>;
    expect(unique.find((i) => i.name === "ingest_batches_token")?.unique).toBe(1);
  });

  it("holds no table beyond the model and no view beyond the contract's list", async () => {
    const db = await ready;
    const names = (type: string) =>
      (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all(type) as Array<{ name: string }>
      ).map((r) => r.name);
    expect(names("table")).toEqual(
      [...OBSERVABILITY_TABLES, ...VECTOR_TABLES, "ingest_batches"].sort(),
    );
    expect(names("view")).toEqual([...OBSERVABILITY_VIEWS].sort());
  });

  for (const view of OBSERVABILITY_VIEWS)
    it(`view ${view} compiles and reads`, async () => {
      const db = await ready;
      expect(() => db.prepare(`SELECT * FROM ${view} LIMIT 0`).all()).not.toThrow();
    });

  it("is a file of its own, never a ledger migration", () => {
    expect(SQLITE_SCHEMA_PATH).not.toContain(`${join("gateway", "migrations")}`);
    expect(readFileSync(SQLITE_SCHEMA_PATH, "utf8")).not.toMatch(/schema_migrations/);
  });
});
