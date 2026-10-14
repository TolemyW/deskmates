// T0: receipt versioning around execution with the fake database client, and recovery of what a
// stopped process left behind without resending anything.

import { describe, expect, it } from "vitest";
import { BatchRunner } from "./batch-runner.js";
import { DEFAULT_LIMITS } from "./config.js";
import { openReceiptsDb } from "./db/open-receipts-db.js";
import { ReceiptStore } from "./receipt-store.js";
import type { SqlBatch } from "./submission.js";
import { FakeSql, FakeSqlError, rowsOf } from "./test-support/fake-sql.js";

const batch = (...cases: string[][]): SqlBatch => ({
  batch_id: "b1",
  cases: cases.map((steps, i) => ({ id: `c${i}`, source: "s", adaptation: "a", steps })),
});

function setup(fake: FakeSql) {
  const store = new ReceiptStore(openReceiptsDb(":memory:"));
  const runner = new BatchRunner({ store, sessions: fake.factory, limits: DEFAULT_LIMITS });
  const accept = (b: SqlBatch, receiptId = "rcpt_1") =>
    store.accept({
      receiptId,
      contentHash: "a".repeat(64),
      idempotencyKey: receiptId,
      validationId: "val_1",
      batch: b,
      summary: "accepted",
    });
  return { store, runner, accept };
}

describe("BatchRunner", () => {
  it("goes accepted -> running -> succeeded, one version per status", async () => {
    const fake = new FakeSql((sql) =>
      sql === "bad" ? new FakeSqlError("syntax error", "42601") : rowsOf([["1"]]),
    );
    const { store, runner, accept } = setup(fake);
    accept(batch(["SELECT 1", "bad"]));
    runner.enqueue("rcpt_1");
    await runner.whenIdle();
    const r = store.mustGet("rcpt_1");
    expect(r.versions.map((v) => [v.version, v.status])).toEqual([
      [1, "accepted"],
      [2, "running"],
      [3, "succeeded"],
    ]);
    expect(r.resultRef).toBe("/receipt/rcpt_1");
    expect(JSON.parse(r.detail ?? "").summary).toBe(
      "batch b1: 2 statements: 1 ok, 1 error, 0 uncertain, 0 not run",
    );
    expect(r.cases[0]?.statements.map((s) => s.outcome)).toEqual(["ok", "error"]);
  });

  it("fails a batch with an uncertain statement", async () => {
    const fake = new FakeSql((sql) =>
      sql === "slow" ? new FakeSqlError("canceling statement", "57014") : rowsOf([]),
    );
    const { store, runner, accept } = setup(fake);
    accept(batch(["slow", "SELECT 1"]));
    runner.enqueue("rcpt_1");
    await runner.whenIdle();
    expect(store.mustGet("rcpt_1")).toMatchObject({ status: "failed", version: 3 });
  });

  it("runs receipts one at a time in submit order", async () => {
    const fake = new FakeSql(() => rowsOf([]));
    const { runner, accept } = setup(fake);
    accept(batch(["SELECT 'a1'", "SELECT 'a2'"]), "rcpt_a");
    accept(batch(["SELECT 'b1'"]), "rcpt_b");
    runner.enqueue("rcpt_a");
    runner.enqueue("rcpt_b");
    await runner.whenIdle();
    expect(fake.executed).toEqual(["SELECT 'a1'", "SELECT 'a2'", "SELECT 'b1'"]);
  });

  it("recovers: runs an accepted receipt and fails a running one without resending", async () => {
    const fake = new FakeSql(() => rowsOf([["1"]]));
    const { store, runner, accept } = setup(fake);
    accept(batch(["SELECT 'queued'"]), "rcpt_a");
    accept(
      batch(["SELECT 'sent'", "SELECT 'maybe'", "SELECT 'never'"], ["SELECT 'later'"]),
      "rcpt_b",
    );
    store.appendVersion("rcpt_b", "running", "running");
    store.recordStatement("rcpt_b", 0, {
      index: 0,
      sql: "SELECT 'sent'",
      ok: true,
      outcome: "ok",
      durationMs: 1,
    });
    runner.recover();
    await runner.whenIdle();
    expect(fake.executed).toEqual(["SELECT 'queued'"]);
    expect(store.mustGet("rcpt_a").status).toBe("succeeded");
    const b = store.mustGet("rcpt_b");
    expect(b).toMatchObject({ status: "failed", version: 3 });
    expect(b.cases.map((c) => c.statements.map((s) => s.outcome))).toEqual([
      ["ok", "uncertain", "not_run"],
      ["not_run"],
    ]);
  });
});
