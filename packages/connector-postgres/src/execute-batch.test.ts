// T0: executing a batch with the fake database client. One connection per case, statements in
// order, a failed statement does not stop the case, a timeout or a connection loss is recorded as
// uncertain and never retried, and a connection loss ends the case.

import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "./config.js";
import { executeBatch } from "./execute-batch.js";
import type { SqlBatch } from "./submission.js";
import { FakeSql, FakeSqlError, commandOf, rowsOf } from "./test-support/fake-sql.js";

const batch = (...cases: string[][]): SqlBatch => ({
  batch_id: "b1",
  cases: cases.map((steps, i) => ({ id: `c${i}`, source: "s", adaptation: "a", steps })),
});

const limits = { ...DEFAULT_LIMITS, resultRowsPerStatement: 2, statementTimeoutMs: 1000 };

function run(fake: FakeSql, b: SqlBatch, extra: Partial<Parameters<typeof executeBatch>[1]> = {}) {
  const recorded: [number, number][] = [];
  return {
    recorded,
    result: executeBatch(b, {
      sessions: fake.factory,
      limits,
      onStatement: (caseIndex, r) => {
        recorded.push([caseIndex, r.index]);
      },
      ...extra,
    }),
  };
}

describe("executeBatch", () => {
  it("runs each case on its own connection with the statement timeout and caps rows", async () => {
    const fake = new FakeSql((sql) =>
      sql.startsWith("SELECT") ? rowsOf([["1"], ["2"], ["3"]], ["a"]) : commandOf("INSERT", 1),
    );
    const { result, recorded } = run(
      fake,
      batch(["INSERT INTO t VALUES (1)", "SELECT a FROM t"], ["SELECT 1"]),
    );
    const cases = await result;
    expect(fake.sessions.map((s) => [s.statements.length, s.closed])).toEqual([
      [2, true],
      [1, true],
    ]);
    expect(fake.sessions[0]?.options.statementTimeoutMs).toBe(1000);
    const select = cases[0]?.statements[1];
    expect(select).toMatchObject({
      index: 1,
      sql: "SELECT a FROM t",
      ok: true,
      outcome: "ok",
      command: "SELECT",
      rowCount: 3,
      columns: [{ name: "a", typeOid: 25 }],
      rows: [["1"], ["2"]],
      truncated: true,
    });
    expect(typeof select?.durationMs).toBe("number");
    expect(cases[0]?.statements[0]).toMatchObject({ ok: true, command: "INSERT", rowCount: 1 });
    expect(recorded).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
    ]);
  });

  it("records a failed statement with its SQLSTATE and runs the rest of the case", async () => {
    const fake = new FakeSql((sql) =>
      sql === "bad" ? new FakeSqlError('relation "x" does not exist', "42P01") : rowsOf([["1"]]),
    );
    const cases = await run(fake, batch(["bad", "SELECT 1"])).result;
    expect(cases[0]?.statements).toEqual([
      expect.objectContaining({
        ok: false,
        outcome: "error",
        error: { sqlstate: "42P01", message: 'relation "x" does not exist' },
      }),
      expect.objectContaining({ ok: true, outcome: "ok" }),
    ]);
  });

  it("records a server-side statement timeout as uncertain, keeps going, never retries", async () => {
    const fake = new FakeSql((sql) =>
      sql === "slow"
        ? new FakeSqlError("canceling statement due to statement timeout", "57014")
        : rowsOf([["1"]]),
    );
    const cases = await run(fake, batch(["slow", "SELECT 1"])).result;
    expect(cases[0]?.statements[0]).toMatchObject({
      ok: false,
      outcome: "uncertain",
      error: { sqlstate: "57014" },
    });
    expect(cases[0]?.statements[1]).toMatchObject({ outcome: "ok" });
    expect(fake.executed.filter((s) => s === "slow")).toHaveLength(1);
  });

  it("ends the case on a connection loss, marks the rest not run, and opens a new one for the next case", async () => {
    const fake = new FakeSql((sql) =>
      sql === "boom" ? new FakeSqlError("Connection terminated unexpectedly") : rowsOf([["1"]]),
    );
    const cases = await run(fake, batch(["SELECT 1", "boom", "SELECT 2"], ["SELECT 3"])).result;
    expect(cases[0]?.statements.map((s) => s.outcome)).toEqual(["ok", "uncertain", "not_run"]);
    expect(cases[0]?.statements[1]?.error).toEqual({
      sqlstate: null,
      message: "Connection terminated unexpectedly",
    });
    expect(cases[1]?.statements.map((s) => s.outcome)).toEqual(["ok"]);
    expect(fake.executed).toEqual(["SELECT 1", "boom", "SELECT 3"]);
    expect(fake.sessions[0]?.destroyed).toBe(true);
  });

  it("treats SQLSTATE class 08 and admin shutdown as connection loss", async () => {
    for (const code of ["08006", "57P01"]) {
      const fake = new FakeSql((sql) =>
        sql === "x" ? new FakeSqlError("gone", code) : rowsOf([]),
      );
      const cases = await run(fake, batch(["x", "SELECT 1"])).result;
      expect(cases[0]?.statements.map((s) => s.outcome)).toEqual(["uncertain", "not_run"]);
    }
  });

  it("drops a connection whose statement outlives the client-side deadline", async () => {
    const fake = new FakeSql((sql) => (sql === "hang" ? "hang" : rowsOf([["1"]])));
    const cases = await run(fake, batch(["hang", "SELECT 1"], ["SELECT 2"]), { graceMs: 10 })
      .result;
    expect(cases[0]?.statements.map((s) => s.outcome)).toEqual(["uncertain", "not_run"]);
    expect(cases[0]?.statements[0]?.error?.message).toMatch(/deadline/);
    expect(fake.sessions[0]?.destroyed).toBe(true);
    expect(cases[1]?.statements.map((s) => s.outcome)).toEqual(["ok"]);
  });

  it("records a failed connect on the case and runs nothing in it", async () => {
    const fake = new FakeSql(() => rowsOf([["1"]]));
    fake.failNextConnect = new FakeSqlError("password authentication failed", "28P01");
    const cases = await run(fake, batch(["SELECT 1"], ["SELECT 2"])).result;
    expect(cases[0]).toMatchObject({
      caseId: "c0",
      connectError: { sqlstate: "28P01", message: "password authentication failed" },
      statements: [expect.objectContaining({ outcome: "not_run" })],
    });
    expect(cases[1]?.statements[0]?.outcome).toBe("ok");
  });

  it("redacts the secrets it is given from every error message", async () => {
    const fake = new FakeSql(() => new FakeSqlError("bad password pw-secret for u", "28P01"));
    const cases = await run(fake, batch(["SELECT 1"]), { secrets: ["pw-secret"] }).result;
    expect(cases[0]?.statements[0]?.error?.message).toBe("bad password [redacted] for u");
  });
});
