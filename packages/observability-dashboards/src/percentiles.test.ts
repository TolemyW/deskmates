// T0 (ADR-0046 amendment 2 decision 19): the nearest-rank percentile helper, run in SQLite against
// a JavaScript reference: ungrouped and grouped, NULLs left out, one row for an empty input, and
// the bounds of what it accepts.

import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { percentiles } from "./percentiles.js";

const db = new Database(":memory:");
afterAll(() => db.close());
db.exec("CREATE TABLE samples (grp TEXT, v REAL)");

/** The nearest-rank percentile: the value at rank ceil(p * n / 100) of the sorted values. */
function reference(values: number[], p: number): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.ceil((p * sorted.length) / 100) - 1] ?? null;
}

const PS = [1, 50, 90, 95, 99, 100] as const;

function load(rows: Array<[string, number | null]>) {
  db.exec("DELETE FROM samples");
  const insert = db.prepare("INSERT INTO samples VALUES (?, ?)");
  for (const row of rows) insert.run(...row);
}

describe("percentiles", () => {
  for (const size of [1, 2, 3, 7, 10, 101])
    it(`matches the nearest-rank reference over ${size} values`, () => {
      const values = Array.from({ length: size }, (_, i) => ((i * 37) % size) * 1.5 + 2);
      load(values.map((v) => ["a", v]));
      const row = db
        .prepare(`${percentiles({ from: "SELECT v FROM samples", value: "v", ps: PS })}`)
        .get() as Record<string, number>;
      expect(row.n).toBe(size);
      for (const p of PS) expect(row[`p${p}`], `p${p}`).toBe(reference(values, p));
    });

  it("computes per group and leaves NULLs out", () => {
    const data: Array<[string, number | null]> = [
      ["a", 5],
      ["a", 1],
      ["a", null],
      ["a", 3],
      ["b", 10],
      ["b", null],
      ["c", null],
    ];
    load(data);
    const rows = db
      .prepare(
        `SELECT * FROM (${percentiles({
          from: "SELECT grp, v FROM samples",
          value: "v",
          by: ["grp"],
          ps: [50, 95],
        })}) q ORDER BY grp`,
      )
      .all();
    expect(rows).toEqual([
      { grp: "a", n: 3, p50: reference([5, 1, 3], 50), p95: reference([5, 1, 3], 95) },
      { grp: "b", n: 1, p50: 10, p95: 10 },
    ]);
  });

  it("answers one row with nulls for an empty input", () => {
    load([]);
    expect(
      db.prepare(percentiles({ from: "SELECT v FROM samples", value: "v", ps: [50] })).all(),
    ).toEqual([{ n: 0, p50: null }]);
  });

  it("refuses what it cannot write portably", () => {
    expect(() => percentiles({ from: "SELECT 1", value: "v; drop", ps: [50] })).toThrow();
    expect(() => percentiles({ from: "SELECT 1", value: "v", ps: [] })).toThrow();
    expect(() => percentiles({ from: "SELECT 1", value: "v", ps: [0] })).toThrow();
    expect(() => percentiles({ from: "SELECT 1", value: "v", ps: [99.9] })).toThrow();
  });
});
