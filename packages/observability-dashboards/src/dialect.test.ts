// T0 (ADR-0046 decision 7): the macro table. Every macro expands in every dialect, and the SQLite
// expansions, run in a real SQLite, answer what the macro promises: a JavaScript reference for
// each case (a regular expression with the dotAll flag for regexExtract).

import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import {
  DIALECTS,
  type Dialect,
  NOW,
  literal,
  parseExtractPattern,
  sqliteDialect,
} from "./dialect.js";

const db = new Database(":memory:");
afterAll(() => db.close());

/** One SQL expression's value. */
const value = (sql: string): unknown =>
  (db.prepare(`SELECT ${sql} AS v`).get() as { v: unknown }).v;

/** A relation of `rows` with the given columns, as a SELECT. */
function rows(columns: string[], data: unknown[][]): string {
  if (data.length === 0) return `SELECT ${columns.map((c) => `NULL AS ${c}`).join(", ")} WHERE 0`;
  return data
    .map(
      (row) =>
        `SELECT ${row
          .map((cell, i) => {
            const text =
              cell === null
                ? "NULL"
                : typeof cell === "number"
                  ? String(cell)
                  : literal(String(cell));
            return `${text} AS ${columns[i]}`;
          })
          .join(", ")}`,
    )
    .join(" UNION ALL ");
}

const PATTERNS = [
  "^mcp__(.+?)__",
  "mcp__(.*?)__",
  "^(.*?):",
  "error: (.+?)$",
  "(.+?)$",
  "\\.(.+?)\\)",
  "^\\[(.*?)\\]",
];

const SAMPLES = [
  "mcp__playwright__browser_click",
  "mcp__deskmates__thread_post",
  "mcp____x",
  "mcp__a",
  "xmcp__a__b",
  "Bash",
  "",
  "a:b:c",
  ":lead",
  "error: model not served",
  "error: ",
  "f(x.y) and g(z.w)",
  "[tag] rest]",
  "line one\nline two: mcp__multi\nline__",
  "ünïcødé mcp__çå__ ok",
];

describe("dialect macros", () => {
  const macros: Array<[string, (d: Dialect) => string]> = [
    ["hourBucket", (d) => d.hourBucket("ts")],
    ["median", (d) => d.median({ from: "SELECT 1 AS v", value: "v", by: [] })],
    ["regexExtract", (d) => d.regexExtract("t", "^mcp__(.+?)__")],
    ["timeDiffMs", (d) => d.timeDiffMs(NOW, "ts")],
    ["jsonField", (d) => d.jsonField("j", ["a", "b"])],
  ];
  for (const [engine, dialect] of Object.entries(DIALECTS))
    for (const [name, expand] of macros)
      it(`${name} expands in ${engine}`, () => {
        expect(dialect.engine).toBe(engine);
        expect(expand(dialect).trim()).not.toBe("");
      });
});

describe("sqlite expansions", () => {
  const d = sqliteDialect;

  it("hourBucket truncates ISO-8601 UTC text to its hour", () => {
    expect(value(d.hourBucket("'2026-10-17T12:34:56.789Z'"))).toBe("2026-10-17T12:00:00Z");
    expect(value(d.hourBucket("'2026-10-17T00:00:00.000Z'"))).toBe("2026-10-17T00:00:00Z");
    expect(value(d.hourBucket("NULL"))).toBeNull();
  });

  it("median is the middle value, or the mean of the two middle ones, without NULLs", () => {
    const median = (data: (number | null)[]) =>
      (
        db
          .prepare(
            `SELECT median FROM (${d.median({
              from: rows(
                ["v"],
                data.map((v) => [v]),
              ),
              value: "v",
            })})`,
          )
          .get() as { median: number | null } | undefined
      )?.median;
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([7])).toBe(7);
    expect(median([null, 2, null, 8])).toBe(5);
    expect(median([])).toBeNull();
  });

  it("median groups by its columns, one row per group", () => {
    const from = rows(
      ["g", "h", "v"],
      [
        ["a", "x", 1],
        ["a", "x", 10],
        ["a", "x", 2],
        ["a", "x", 3],
        ["a", "y", 4],
        ["b", "x", 7],
        ["b", "x", null],
      ],
    );
    const got = db
      .prepare(`SELECT * FROM (${d.median({ from, value: "v", by: ["g", "h"] })}) ORDER BY g, h`)
      .all();
    expect(got).toEqual([
      { g: "a", h: "x", median: 2.5 },
      { g: "a", h: "y", median: 4 },
      { g: "b", h: "x", median: 7 },
    ]);
  });

  it("median refuses a column that is not a plain identifier", () => {
    expect(() => d.median({ from: "SELECT 1 AS v", value: "v; DROP" })).toThrow(/identifier/);
    expect(() => d.median({ from: "SELECT 1 AS v", value: "v", by: ["a b"] })).toThrow(
      /identifier/,
    );
  });

  for (const pattern of PATTERNS)
    it(`regexExtract ${pattern} agrees with the regular expression`, () => {
      const re = new RegExp(pattern, "s");
      for (const sample of SAMPLES) {
        const expected = re.exec(sample)?.[1] ?? null;
        expect(value(d.regexExtract(literal(sample), pattern)), JSON.stringify(sample)).toBe(
          expected,
        );
      }
      expect(value(d.regexExtract("NULL", pattern))).toBeNull();
    });

  it("regexExtract refuses a pattern outside the portable subset", () => {
    for (const bad of [
      "(\\d+)",
      "a(.*)b",
      "a(.*?)",
      "a|b(.*?)c",
      "a(.*?)b(.*?)c",
      "a(.*?)b$",
      "[a](.*?)b",
    ])
      expect(() => parseExtractPattern(bad), bad).toThrow(/regexExtract/);
    expect(parseExtractPattern("^mcp\\.x(.+?)__")).toEqual({
      anchored: true,
      prefix: "mcp.x",
      nonEmpty: true,
      suffix: "__",
    });
  });

  it("timeDiffMs is milliseconds between two timestamps, or from one to now", () => {
    const ms = value(d.timeDiffMs("'2026-10-17T12:00:01.500Z'", "'2026-10-17T12:00:00.000Z'"));
    expect(Math.round(ms as number)).toBe(1500);
    const day = value(d.timeDiffMs("'2026-10-18T00:00:00Z'", "'2026-10-17T00:00:00Z'"));
    expect(Math.round(day as number)).toBe(86_400_000);
    const since = value(d.timeDiffMs(NOW, literal(new Date(Date.now() - 60_000).toISOString())));
    expect(Math.abs((since as number) - 60_000)).toBeLessThan(5_000);
    expect(value(d.timeDiffMs("NULL", "'2026-10-17T00:00:00Z'"))).toBeNull();
  });

  it("jsonField reads a scalar at a key path, or NULL", () => {
    const doc = literal('{"a":{"b":7,"c":"text"},"d":[1]}');
    expect(value(d.jsonField(doc, ["a", "b"]))).toBe(7);
    expect(value(d.jsonField(doc, ["a", "c"]))).toBe("text");
    expect(value(d.jsonField(doc, ["a", "missing"]))).toBeNull();
    expect(value(d.jsonField("NULL", ["a"]))).toBeNull();
    expect(() => d.jsonField(doc, ["a.b"])).toThrow(/identifier/);
    expect(() => d.jsonField(doc, [])).toThrow(/at least one key/);
  });

  it("quotes literals", () => {
    expect(value(literal("it's"))).toBe("it's");
  });
});
