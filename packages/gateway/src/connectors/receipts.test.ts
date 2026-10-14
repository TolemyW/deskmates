// T1: receipts are authoritative and live in the Gateway (ADR-0012 item 4, verification row 4).
// A submit produces a receipt row; a status change adds a version and leaves the first; a
// bot-written mirror file that disagrees changes nothing the Gateway returns.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type ConnectorFixture, connectorFixture } from "../test-support/connector-fixture.js";

const fixtures: ConnectorFixture[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function submitted(f: ConnectorFixture) {
  const v = await f.ctx.connectorProxy.validate(f.run.id, "tickets", {
    operation: "insert",
    statement: "INSERT INTO t VALUES (1)",
  });
  return f.ctx.connectorProxy.submit(f.run.id, "tickets", {
    validationId: v.validationId,
    contentHash: v.contentHash,
  });
}

describe("receipts", () => {
  it("stores a receipt row with its owner and first version on submit", async () => {
    const f = connectorFixture();
    fixtures.push(f);
    const { receipt } = await submitted(f);
    expect(receipt).toMatchObject({
      connectorId: f.connector.id,
      workspaceId: f.workspace.id,
      runId: f.run.id,
      botId: f.bot.id,
      current: { version: 1, status: "accepted" },
    });
    expect(f.ctx.connectorReceipts.listForRun(f.run.id)).toHaveLength(1);
  });

  it("adds a version on a status change and keeps the first", async () => {
    const f = connectorFixture();
    fixtures.push(f);
    const { receipt } = await submitted(f);
    f.fake.advance(receipt.receiptId, "running");
    const running = await f.ctx.connectorProxy.status(f.run.id, "tickets", receipt.receiptId);
    f.fake.advance(receipt.receiptId, "succeeded", "result:42");
    const done = await f.ctx.connectorProxy.receipt(f.run.id, "tickets", receipt.receiptId);
    expect(running.versions.map((v) => v.status)).toEqual(["accepted", "running"]);
    expect(done.versions.map((v) => [v.version, v.status])).toEqual([
      [1, "accepted"],
      [2, "running"],
      [3, "succeeded"],
    ]);
    expect(done.current).toMatchObject({ status: "succeeded", resultRef: "result:42" });
    // Asking again without a change adds nothing.
    const same = await f.ctx.connectorProxy.status(f.run.id, "tickets", receipt.receiptId);
    expect(same.versions).toHaveLength(3);
  });

  it("refuses to update or delete a stored receipt or version", async () => {
    const f = connectorFixture();
    fixtures.push(f);
    const { receipt } = await submitted(f);
    expect(() =>
      f.db
        .prepare("UPDATE connector_receipt_versions SET status = 'succeeded' WHERE receipt_id = ?")
        .run(receipt.receiptId),
    ).toThrow(/immutable/);
    expect(() =>
      f.db.prepare("DELETE FROM connector_receipts WHERE receipt_id = ?").run(receipt.receiptId),
    ).toThrow(/immutable/);
  });

  it("answers from the Gateway's record, not from a bot-written mirror file", async () => {
    const f = connectorFixture();
    fixtures.push(f);
    const { receipt } = await submitted(f);
    const work = mkdtempSync(join(tmpdir(), "deskmates-mirror-"));
    dirs.push(work);
    writeFileSync(
      join(work, `${receipt.receiptId}.json`),
      JSON.stringify({ ...receipt, current: { version: 9, status: "succeeded" } }),
    );
    const read = await f.ctx.connectorProxy.receipt(f.run.id, "tickets", receipt.receiptId);
    expect(read.current).toMatchObject({ version: 1, status: "accepted" });
    expect(read.versions).toHaveLength(1);
  });

  it("does not know a receipt that was not submitted through the Gateway", async () => {
    const f = connectorFixture();
    fixtures.push(f);
    await expect(
      f.ctx.connectorProxy.receipt(f.run.id, "tickets", "rcpt-elsewhere"),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
