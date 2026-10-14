// T1: submit is bound to a prior validation and idempotent (ADR-0012 item 5, verification row 5).
// Metric: duplicate execution count, exactly 0 — the fake connector's own counter is the witness.

import { afterEach, describe, expect, it } from "vitest";
import { type ConnectorFixture, connectorFixture } from "../test-support/connector-fixture.js";

const fixtures: ConnectorFixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
function setup(opts: Parameters<typeof connectorFixture>[0] = {}) {
  const f = connectorFixture(opts);
  fixtures.push(f);
  return f;
}

const SUBMISSION = { operation: "insert", statement: "INSERT INTO t VALUES (1)" };

async function refused(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  return (err as { code?: string } | undefined)?.code ?? "no error";
}

describe("submit binding", () => {
  it("refuses a submit without a validation", async () => {
    const f = setup();
    const code = await refused(
      f.ctx.connectorProxy.submit(f.run.id, "tickets", {
        validationId: "val-none",
        contentHash: "a".repeat(64),
      }),
    );
    expect(code).toBe("connector_validation_missing");
    expect(f.fake.executions).toBe(0);
  });

  it("refuses a stale validation", async () => {
    const f = setup({ ttlSeconds: 900 });
    const v = await f.ctx.connectorProxy.validate(f.run.id, "tickets", SUBMISSION);
    f.advanceSeconds(900);
    const code = await refused(
      f.ctx.connectorProxy.submit(f.run.id, "tickets", {
        validationId: v.validationId,
        contentHash: v.contentHash,
      }),
    );
    expect(code).toBe("connector_validation_stale");
    expect(f.fake.executions).toBe(0);
  });

  it("refuses a content hash that differs from the validated one, naming both", async () => {
    const f = setup();
    const v = await f.ctx.connectorProxy.validate(f.run.id, "tickets", SUBMISSION);
    const err = await f.ctx.connectorProxy
      .submit(f.run.id, "tickets", { validationId: v.validationId, contentHash: "b".repeat(64) })
      .then(
        () => undefined,
        (e: unknown) => e as { code: string; details: Record<string, unknown> },
      );
    expect(err?.code).toBe("connector_hash_mismatch");
    expect(err?.details).toMatchObject({
      validatedHash: v.contentHash,
      submittedHash: "b".repeat(64),
    });
    expect(f.fake.executions).toBe(0);
  });

  it("refuses a validation made on another connector", async () => {
    const f = setup();
    f.ctx.connectors.register({
      workspaceId: f.workspace.id,
      name: "reports",
      url: "http://reports.connector.internal",
    });
    const v = await f.ctx.connectorProxy.validate(f.run.id, "tickets", SUBMISSION);
    const code = await refused(
      f.ctx.connectorProxy.submit(f.run.id, "reports", {
        validationId: v.validationId,
        contentHash: v.contentHash,
      }),
    );
    expect(code).toBe("connector_validation_wrong_connector");
    expect(f.fake.executions).toBe(0);
  });

  it("refuses a validation that found errors", async () => {
    const f = setup();
    const v = await f.ctx.connectorProxy.validate(f.run.id, "tickets", { operation: "insert" });
    expect(v.valid).toBe(false);
    expect(v.errors[0]).toMatchObject({ path: "statement", code: "required" });
    const code = await refused(
      f.ctx.connectorProxy.submit(f.run.id, "tickets", {
        validationId: v.validationId,
        contentHash: v.contentHash,
      }),
    );
    expect(code).toBe("connector_validation_invalid");
    expect(f.fake.executions).toBe(0);
  });
});

describe("idempotency", () => {
  it("returns the same receipt for a repeated key and the connector executes once", async () => {
    const f = setup();
    const v = await f.ctx.connectorProxy.validate(f.run.id, "tickets", SUBMISSION);
    const input = { validationId: v.validationId, contentHash: v.contentHash, idempotencyKey: "k" };
    const first = await f.ctx.connectorProxy.submit(f.run.id, "tickets", input);
    const again = await f.ctx.connectorProxy.submit(f.run.id, "tickets", input);
    expect(first.duplicate).toBe(false);
    expect(again.duplicate).toBe(true);
    expect(again.receipt.receiptId).toBe(first.receipt.receiptId);
    expect(f.fake.executions).toBe(1);
  });

  it("executes once when two identical submits race", async () => {
    const f = setup();
    const v = await f.ctx.connectorProxy.validate(f.run.id, "tickets", SUBMISSION);
    const input = { validationId: v.validationId, contentHash: v.contentHash };
    const [a, b] = await Promise.all([
      f.ctx.connectorProxy.submit(f.run.id, "tickets", input),
      f.ctx.connectorProxy.submit(f.run.id, "tickets", input),
    ]);
    expect(a.receipt.receiptId).toBe(b.receipt.receiptId);
    expect(f.fake.executions).toBe(1);
  });

  it("still returns the receipt for a repeated key after the validation expired", async () => {
    const f = setup({ ttlSeconds: 60 });
    const v = await f.ctx.connectorProxy.validate(f.run.id, "tickets", SUBMISSION);
    const input = { validationId: v.validationId, contentHash: v.contentHash, idempotencyKey: "k" };
    const first = await f.ctx.connectorProxy.submit(f.run.id, "tickets", input);
    f.advanceSeconds(3600);
    const again = await f.ctx.connectorProxy.submit(f.run.id, "tickets", input);
    expect(again.receipt.receiptId).toBe(first.receipt.receiptId);
    expect(f.fake.executions).toBe(1);
  });

  it("treats a new idempotency key as a new submission", async () => {
    const f = setup();
    const v = await f.ctx.connectorProxy.validate(f.run.id, "tickets", SUBMISSION);
    const base = { validationId: v.validationId, contentHash: v.contentHash };
    const a = await f.ctx.connectorProxy.submit(f.run.id, "tickets", {
      ...base,
      idempotencyKey: "a",
    });
    const b = await f.ctx.connectorProxy.submit(f.run.id, "tickets", {
      ...base,
      idempotencyKey: "b",
    });
    expect(a.receipt.receiptId).not.toBe(b.receipt.receiptId);
    expect(f.fake.executions).toBe(2);
  });
});
