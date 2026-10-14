// T0: the statement classifier decides the effect class of one step and rejects the statement
// kinds this connector does not run (procedures, transaction control, extensions, COPY).

import { describe, expect, it } from "vitest";
import { classifyStatement } from "./classify-statement.js";

describe("classifyStatement", () => {
  it.each([
    ["SELECT 1", "SELECT"],
    ["select a, count(*) from t group by a order by a;", "SELECT"],
    ["WITH x AS (SELECT 1 AS a) SELECT a FROM x", "WITH"],
    [
      "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r WHERE n<3) SELECT * FROM r",
      "WITH",
    ],
    ["SELECT 1 UNION SELECT 2", "SELECT"],
    ["VALUES (1), (2)", "SELECT"],
    ["EXPLAIN SELECT 1", "EXPLAIN"],
    ["explain (costs off) SELECT * FROM t", "EXPLAIN"],
    ["SHOW search_path", "SHOW"],
    ["-- a comment\n/* and another */ SELECT 1", "SELECT"],
  ])("%s is a read (%s)", (sql, kind) => {
    expect(classifyStatement(sql)).toEqual({ ok: true, kind, effect: "read" });
  });

  it.each([
    ["INSERT INTO t VALUES (1)", "INSERT"],
    ["UPDATE t SET a = 1", "UPDATE"],
    ["DELETE FROM t WHERE a = 1", "DELETE"],
    ["CREATE TABLE t (a int, b varchar(2))", "CREATE TABLE"],
    ["ALTER TABLE t ADD COLUMN c int", "ALTER TABLE"],
    ["DROP TABLE t", "DROP TABLE"],
    ["TRUNCATE t", "TRUNCATE TABLE"],
    ["CREATE INDEX i ON t (a)", "CREATE INDEX"],
    ["WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x", "WITH"],
    ["SELECT nextval('s')", "SELECT"],
    ["SELECT (SELECT setval('s', 3))", "SELECT"],
    ["EXPLAIN ANALYZE DELETE FROM t", "EXPLAIN"],
    ["EXPLAIN (ANALYZE, COSTS OFF) INSERT INTO t VALUES (1)", "EXPLAIN"],
  ])("%s is external (%s)", (sql, kind) => {
    expect(classifyStatement(sql)).toEqual({ ok: true, kind, effect: "external" });
  });

  it.each([
    "BEGIN",
    "COMMIT",
    "ROLLBACK",
    "START TRANSACTION",
    "SAVEPOINT a",
    "END",
    "CREATE PROCEDURE p() LANGUAGE sql AS $$ SELECT 1 $$",
    "create or replace procedure p() as $$ $$ language sql",
    "CALL p()",
    "DO $$ BEGIN END $$",
    "COPY t FROM STDIN",
    "COPY t TO '/tmp/x'",
    "CREATE EXTENSION vector",
    "SET statement_timeout = 0",
    "SET LOCAL statement_timeout TO 0",
    "RESET statement_timeout",
    "SELECT set_config('statement_timeout', '0', false)",
  ])("%s is rejected as unsupported", (sql) => {
    const c = classifyStatement(sql);
    expect(c.ok).toBe(false);
    expect(c.ok === false && c.code).toBe("unsupported");
  });

  it("rejects a syntax error as invalid and names the parser's position", () => {
    const c = classifyStatement("SELEC 1");
    expect(c).toMatchObject({ ok: false, code: "invalid" });
    expect(c.ok === false && c.message).toMatch(/line 1 col/);
  });

  it("rejects more than one statement in a step", () => {
    expect(classifyStatement("SELECT 1; SELECT 2")).toMatchObject({ ok: false, code: "invalid" });
    expect(classifyStatement("SELECT 1; COMMIT")).toMatchObject({ ok: false });
  });

  it("rejects an empty step", () => {
    expect(classifyStatement("  ;  ")).toMatchObject({ ok: false, code: "invalid" });
    expect(classifyStatement("-- only a comment")).toMatchObject({ ok: false, code: "invalid" });
  });

  it("treats EXPLAIN ANALYZE of a read as a read", () => {
    expect(classifyStatement("EXPLAIN ANALYZE SELECT 1")).toEqual({
      ok: true,
      kind: "EXPLAIN",
      effect: "read",
    });
  });

  it("accepts other session settings as external", () => {
    expect(classifyStatement("SET search_path = public")).toEqual({
      ok: true,
      kind: "SET",
      effect: "external",
    });
  });
});
