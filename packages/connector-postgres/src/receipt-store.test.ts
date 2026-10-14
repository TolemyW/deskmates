// T0: the receipt store is append-only, versions every status change, is keyed for idempotency
// on (contentHash, idempotencyKey) and survives a restart of the service.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConnectorReceipt } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { openReceiptsDb } from "./db/open-receipts-db.js";
import { ReceiptStore } from "./receipt-store.js";
import type { SqlBatch } from "./submission.js";

const HASH = "a".repeat(64);
const batch: SqlBatch = {
  batch_id: "b1",
  cases: [{ id: "c0", source: "s", adaptation: "a", steps: ["SELECT 1", "SELECT 2"] }],
};
const accept = (store: ReceiptStore, receiptId = "rcpt_1", key = "k1") =>
  store.accept({
    receiptId,
    contentHash: HASH,
    idempotencyKey: key,
    validationId: "val_1",
    batch,
    summary: "batch b1",
  });

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("ReceiptStore", () => {
  it("creates version 1 accepted and appends a version per status change", () => {
    const store = new ReceiptStore(openReceiptsDb(":memory:"));
    const first = accept(store);
    expect(parseConnectorReceipt(first)).toMatchObject({ status: "accepted", version: 1 });
    store.appendVersion("rcpt_1", "running", "running");
    const done = store.appendVersion("rcpt_1", "succeeded", "done", [
      { caseId: "c0", statements: [] },
    ]);
    expect(done.version).toBe(3);
    expect(done.versions.map((v) => [v.version, v.status])).toEqual([
      [1, "accepted"],
      [2, "running"],
      [3, "succeeded"],
    ]);
    expect(JSON.parse(done.detail ?? "")).toEqual({
      summary: "done",
      cases: [{ caseId: "c0", statements: [] }],
    });
  });

  it("finds a receipt by content hash and idempotency key and refuses a second one", () => {
    const store = new ReceiptStore(openReceiptsDb(":memory:"));
    accept(store);
    expect(store.findByKey(HASH, "k1")).toBe("rcpt_1");
    expect(store.findByKey(HASH, "k2")).toBeUndefined();
    expect(() => accept(store, "rcpt_2", "k1")).toThrow(/UNIQUE/);
  });

  it("refuses to update or delete anything", () => {
    const db = openReceiptsDb(":memory:");
    const store = new ReceiptStore(db);
    accept(store);
    store.recordStatement("rcpt_1", 0, {
      index: 0,
      sql: "SELECT 1",
      ok: true,
      outcome: "ok",
      durationMs: 1,
    });
    expect(() => db.prepare("UPDATE receipt_versions SET status = 'failed'").run()).toThrow(
      /append-only/,
    );
    expect(() => db.prepare("DELETE FROM receipts").run()).toThrow(/append-only/);
    expect(() => db.prepare("UPDATE statement_results SET result_json = '{}'").run()).toThrow(
      /append-only/,
    );
  });

  it("shows the outcomes recorded so far while not terminal", () => {
    const store = new ReceiptStore(openReceiptsDb(":memory:"));
    accept(store);
    store.appendVersion("rcpt_1", "running", "running");
    store.recordStatement("rcpt_1", 0, {
      index: 0,
      sql: "SELECT 1",
      ok: true,
      outcome: "ok",
      durationMs: 1,
    });
    expect(store.mustGet("rcpt_1").cases).toEqual([
      { caseId: "c0", statements: [expect.objectContaining({ index: 0, outcome: "ok" })] },
    ]);
    expect(store.unfinished()).toEqual([{ receiptId: "rcpt_1", status: "running" }]);
  });

  it("keeps receipts across a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "connector-receipts-"));
    dirs.push(dir);
    const path = join(dir, "receipts.sqlite");
    const db1 = openReceiptsDb(path);
    accept(new ReceiptStore(db1));
    db1.close();
    const db2 = openReceiptsDb(path);
    const store = new ReceiptStore(db2);
    expect(store.mustGet("rcpt_1")).toMatchObject({ status: "accepted", version: 1 });
    expect(store.findByKey(HASH, "k1")).toBe("rcpt_1");
    db2.close();
  });
});
