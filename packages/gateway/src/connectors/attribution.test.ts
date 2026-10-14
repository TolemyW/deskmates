// T1: every connector call is attributed in the ledger (ADR-0012 item 7, verification row 7).
// The tool_call and tool_result events carry the connector id, and for submit the validation id,
// content hash and receipt id; a coverage report computed from receipts and events matches the
// fake connector's own log. Metric: coverage reconciliation difference, exactly 0.

import type { RunEvent, RunId } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { type ConnectorFixture, connectorFixture } from "../test-support/connector-fixture.js";

const fixtures: ConnectorFixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});

function connectorEvents(f: ConnectorFixture, runIds: RunId[]): RunEvent[] {
  return runIds
    .flatMap((id) => f.ctx.events.list(id))
    .filter((e) => e.payload.source === "connector_proxy");
}

describe("connector ledger attribution", () => {
  it("pairs every call with events carrying the connector id and the submit ids", async () => {
    const f = connectorFixture();
    fixtures.push(f);
    const p = f.ctx.connectorProxy;
    await p.describe(f.run.id, "tickets");
    const v = await p.validate(f.run.id, "tickets", { operation: "select", statement: "SELECT 1" });
    const { receipt } = await p.submit(f.run.id, "tickets", {
      validationId: v.validationId,
      contentHash: v.contentHash,
    });
    await p.status(f.run.id, "tickets", receipt.receiptId);
    await p.receipt(f.run.id, "tickets", receipt.receiptId);

    const events = connectorEvents(f, [f.run.id]);
    expect(events.map((e) => [e.kind, e.payload.operation])).toEqual([
      ["tool_call", "describe"],
      ["tool_result", "describe"],
      ["tool_call", "validate"],
      ["tool_result", "validate"],
      ["tool_call", "submit"],
      ["tool_result", "submit"],
      ["tool_call", "status"],
      ["tool_result", "status"],
      ["tool_call", "receipt"],
      ["tool_result", "receipt"],
    ]);
    for (const e of events) expect(e.payload.connectorId).toBe(f.connector.id);
    const submitCall = events.find(
      (e) => e.kind === "tool_call" && e.payload.operation === "submit",
    );
    const submitResult = events.find(
      (e) => e.kind === "tool_result" && e.payload.operation === "submit",
    );
    expect(submitCall?.payload).toMatchObject({
      validationId: v.validationId,
      contentHash: v.contentHash,
    });
    expect(submitResult?.payload).toMatchObject({
      validationId: v.validationId,
      contentHash: v.contentHash,
      receiptId: receipt.receiptId,
      isError: false,
    });
    // The ledger keeps the raw result; wrapping exists only in model context (sidecar).
    expect(submitResult?.payload.result).toMatchObject({
      receipt: { receiptId: receipt.receiptId },
    });
  });

  it("records a refused submit as an error result with its typed code", async () => {
    const f = connectorFixture();
    fixtures.push(f);
    await f.ctx.connectorProxy
      .submit(f.run.id, "tickets", { validationId: "val-x", contentHash: "c".repeat(64) })
      .catch(() => undefined);
    const result = connectorEvents(f, [f.run.id]).find((e) => e.kind === "tool_result");
    expect(result?.payload).toMatchObject({
      operation: "submit",
      connectorId: f.connector.id,
      validationId: "val-x",
      isError: true,
      error: { code: "connector_validation_missing" },
    });
  });

  it("reconciles coverage from receipts and events with the connector's own log", async () => {
    const f = connectorFixture();
    fixtures.push(f);
    const second = f.newRun();
    const p = f.ctx.connectorProxy;
    const statements = ["SELECT 1", "SELECT 2", "SELECT 3"];
    for (const [i, statement] of statements.entries()) {
      const run = i === 1 ? second : f.run;
      const v = await p.validate(run.id, "tickets", { operation: "select", statement });
      const input = { validationId: v.validationId, contentHash: v.contentHash };
      await p.submit(run.id, "tickets", input);
      // A retried submit is a duplicate: it must not count twice anywhere.
      await p.submit(run.id, "tickets", input);
    }
    // A refused submit is not coverage.
    await p
      .submit(f.run.id, "tickets", { validationId: "val-none", contentHash: "d".repeat(64) })
      .catch(() => undefined);

    const executedByConnector = new Set(f.fake.executed.map((e) => e.receiptId));
    const fromReceipts = new Set(
      f.ctx.connectorReceipts.listForConnector(f.connector.id).map((r) => r.receiptId),
    );
    const fromEvents = new Set(
      connectorEvents(f, [f.run.id, second.id])
        .filter(
          (e) =>
            e.kind === "tool_result" &&
            e.payload.operation === "submit" &&
            e.payload.isError === false &&
            e.payload.duplicate === false,
        )
        .map((e) => e.payload.receiptId as string),
    );
    expect(f.fake.executions).toBe(3);
    expect([...fromReceipts].sort()).toEqual([...executedByConnector].sort());
    expect([...fromEvents].sort()).toEqual([...executedByConnector].sort());
    // Every receipt is attributed to the run and bot that submitted it.
    const unattributed = f.ctx.connectorReceipts
      .listForConnector(f.connector.id)
      .filter((r) => !r.runId || !r.botId);
    expect(unattributed).toEqual([]);
    expect(f.ctx.connectorReceipts.listForRun(second.id)).toHaveLength(1);
  });
});
