// T0: the dry check of a batch. It never touches a database; it enforces the shape, the limits
// and the statement classifier, with errors whose path names the offending field or step.

import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "./config.js";
import type { SqlBatch, SqlCase } from "./submission.js";
import { validateBatch } from "./validate-batch.js";

const sqlCase = (id: string, steps: string[]): SqlCase => ({
  id,
  source: "postgres/src/test/regress/sql/with.sql",
  adaptation: "renamed tables",
  steps,
});
const batch = (...cases: SqlCase[]): SqlBatch => ({ batch_id: "q01", cases });

describe("validateBatch", () => {
  it("accepts a read-only batch as read and summarises it", () => {
    const v = validateBatch(
      batch(
        sqlCase("a", ["SELECT 1", "SHOW search_path"]),
        sqlCase("b", ["WITH x AS (SELECT 1) SELECT * FROM x"]),
      ),
      DEFAULT_LIMITS,
    );
    expect(v.errors).toEqual([]);
    expect(v.valid).toBe(true);
    expect(v.effect).toBe("read");
    expect(v.statementCount).toBe(3);
    expect(v.summary).toBe(
      "batch q01: 2 cases, 3 statements, effect read (SELECT 1, SHOW 1, WITH 1)",
    );
  });

  it("makes the whole batch external when one statement writes", () => {
    const v = validateBatch(
      batch(
        sqlCase("a", ["CREATE TABLE t (a int)", "INSERT INTO t VALUES (1)", "SELECT * FROM t"]),
      ),
      DEFAULT_LIMITS,
    );
    expect(v.valid).toBe(true);
    expect(v.effect).toBe("external");
    expect(v.summary).toContain("effect external");
  });

  it("names the offending step in each classifier error", () => {
    const v = validateBatch(
      batch(sqlCase("a", ["SELECT 1", "BEGIN"]), sqlCase("b", ["COPY t FROM STDIN", "SELEC 1"])),
      DEFAULT_LIMITS,
    );
    expect(v.valid).toBe(false);
    expect(v.errors.map((e) => [e.path, e.code])).toEqual([
      ["cases[0].steps[1]", "unsupported"],
      ["cases[1].steps[0]", "unsupported"],
      ["cases[1].steps[1]", "invalid"],
    ]);
    expect(v.effect).toBe("external");
    expect(v.summary).toContain("3 errors");
  });

  it("reports schema errors with the contracts field codes", () => {
    const v = validateBatch(
      { batch_id: "q01", cases: [{ id: "a", steps: [1], extra: true }] },
      DEFAULT_LIMITS,
    );
    expect(v.valid).toBe(false);
    expect(v.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "cases[0].source", code: "required" }),
        expect.objectContaining({ path: "cases[0].adaptation", code: "required" }),
        expect.objectContaining({ path: "cases[0].steps[0]", code: "type" }),
        expect.objectContaining({ path: "cases[0].extra", code: "additional_property" }),
      ]),
    );
  });

  it("rejects a submission that is not an object", () => {
    const v = validateBatch("SELECT 1", DEFAULT_LIMITS);
    expect(v.valid).toBe(false);
    expect(v.errors).toEqual([{ path: "", code: "type", message: "submission must be object" }]);
    expect(v.summary).toContain("not a batch");
  });

  it("enforces cases per batch, statements per case and statements per batch", () => {
    const limits = {
      ...DEFAULT_LIMITS,
      casesPerBatch: 2,
      statementsPerCase: 2,
      statementsPerBatch: 3,
    };
    const tooManyCases = validateBatch(
      batch(sqlCase("a", ["SELECT 1"]), sqlCase("b", ["SELECT 1"]), sqlCase("c", ["SELECT 1"])),
      limits,
    );
    expect(tooManyCases.errors).toContainEqual(
      expect.objectContaining({ path: "cases", code: "invalid" }),
    );
    const tooManySteps = validateBatch(
      batch(sqlCase("a", ["SELECT 1", "SELECT 2", "SELECT 3"])),
      limits,
    );
    expect(tooManySteps.errors).toContainEqual(
      expect.objectContaining({ path: "cases[0].steps", code: "invalid" }),
    );
    const tooManyInBatch = validateBatch(
      batch(sqlCase("a", ["SELECT 1", "SELECT 2"]), sqlCase("b", ["SELECT 1", "SELECT 2"])),
      limits,
    );
    expect(tooManyInBatch.errors).toEqual([
      expect.objectContaining({
        path: "cases",
        code: "invalid",
        message: expect.stringMatching(/4 statements/),
      }),
    ]);
  });

  it("enforces the statement size, empty lists and unique case ids", () => {
    const limits = { ...DEFAULT_LIMITS, statementBytes: 20 };
    const v = validateBatch(
      {
        batch_id: "",
        cases: [
          sqlCase("a", [`SELECT '${"x".repeat(30)}'`]),
          sqlCase("a", []),
          sqlCase("", ["SELECT 1"]),
        ],
      },
      limits,
    );
    expect(v.errors.map((e) => e.path)).toEqual([
      "batch_id",
      "cases[0].steps[0]",
      "cases[1].id",
      "cases[1].steps",
      "cases[2].id",
    ]);
    expect(validateBatch({ batch_id: "q", cases: [] }, limits).errors).toEqual([
      expect.objectContaining({ path: "cases", code: "invalid" }),
    ]);
  });
});
