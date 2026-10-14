// T0 self-test of the fake connector (ADR-0012 verification row 1): it speaks the HTTP contract
// typed in contracts, rejects a submission missing a required field with a field-specific error,
// executes once per idempotency key and versions a receipt on every status change.

import { createHash } from "node:crypto";
import {
  canonicalJson,
  parseConnectorCapabilities,
  parseConnectorReceipt,
  parseConnectorValidation,
} from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { FakeConnector, contentHashOf } from "./fake-connector.js";

const post = (c: FakeConnector, path: string, body: unknown, token = "cred-1") =>
  c.fetch(`${c.baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const get = (c: FakeConnector, path: string, token = "cred-1") =>
  c.fetch(`${c.baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });

async function validate(c: FakeConnector, submission: unknown) {
  const res = await post(c, "/validate", { submission, contentHash: contentHashOf(submission) });
  return parseConnectorValidation(await res.json());
}

describe("FakeConnector", () => {
  it("hashes the canonical JSON with sha256", () => {
    const s = { statement: "SELECT 1", operation: "select" };
    expect(contentHashOf(s)).toBe(createHash("sha256").update(canonicalJson(s)).digest("hex"));
    expect(contentHashOf(s)).toBe(contentHashOf({ operation: "select", statement: "SELECT 1" }));
  });

  it("describes itself with a capabilities document that parses", async () => {
    const c = new FakeConnector({ credential: "cred-1" });
    const caps = parseConnectorCapabilities(await (await post(c, "/describe", {})).json());
    expect(caps.operations.map((o) => [o.name, o.effect])).toEqual([
      ["select", "read"],
      ["insert", "reversible"],
      ["notify", "external"],
    ]);
  });

  it("refuses a request without its credential", async () => {
    const c = new FakeConnector({ credential: "cred-1" });
    expect((await post(c, "/describe", {}, "wrong")).status).toBe(401);
  });

  it("rejects a submission missing a required field with a field-specific error", async () => {
    const c = new FakeConnector({ credential: "cred-1" });
    const v = await validate(c, { operation: "select" });
    expect(v.valid).toBe(false);
    expect(v.errors).toEqual([
      { path: "statement", code: "required", message: "statement is required" },
    ]);
  });

  it("reports the scripted effect class per operation", async () => {
    const c = new FakeConnector({ credential: "cred-1", effects: { select: "external" } });
    expect((await validate(c, { operation: "select", statement: "x" })).effect).toBe("external");
    c.setEffect("select", "read");
    expect((await validate(c, { operation: "select", statement: "x" })).effect).toBe("read");
  });

  it("executes once per idempotency key and returns the same receipt on a repeat", async () => {
    const c = new FakeConnector({ credential: "cred-1" });
    const v = await validate(c, { operation: "insert", statement: "INSERT" });
    const submit = {
      validationId: v.validationId,
      contentHash: v.contentHash,
      idempotencyKey: "k1",
    };
    const first = parseConnectorReceipt(await (await post(c, "/submit", submit)).json());
    const again = parseConnectorReceipt(await (await post(c, "/submit", submit)).json());
    expect(again.receiptId).toBe(first.receiptId);
    expect(c.executions).toBe(1);
    expect(c.executed).toEqual([
      {
        receiptId: first.receiptId,
        validationId: v.validationId,
        contentHash: v.contentHash,
        idempotencyKey: "k1",
      },
    ]);
  });

  it("refuses a submit with a hash that is not the validated one", async () => {
    const c = new FakeConnector({ credential: "cred-1" });
    const v = await validate(c, { operation: "insert", statement: "INSERT" });
    const res = await post(c, "/submit", {
      validationId: v.validationId,
      contentHash: "b".repeat(64),
      idempotencyKey: "k1",
    });
    expect(res.status).toBe(409);
    expect(c.executions).toBe(0);
  });

  it("adds a receipt version on every status change", async () => {
    const c = new FakeConnector({ credential: "cred-1" });
    const v = await validate(c, { operation: "insert", statement: "INSERT" });
    const r = parseConnectorReceipt(
      await (
        await post(c, "/submit", {
          validationId: v.validationId,
          contentHash: v.contentHash,
          idempotencyKey: "k",
        })
      ).json(),
    );
    expect(r).toMatchObject({ status: "accepted", version: 1 });
    c.advance(r.receiptId, "succeeded", "rows:3");
    const status = parseConnectorReceipt(await (await get(c, `/status/${r.receiptId}`)).json());
    expect(status).toMatchObject({ status: "succeeded", version: 2, resultRef: "rows:3" });
    const receipt = parseConnectorReceipt(await (await get(c, `/receipt/${r.receiptId}`)).json());
    expect(receipt).toEqual(status);
    expect((await get(c, "/receipt/missing")).status).toBe(404);
  });
});
