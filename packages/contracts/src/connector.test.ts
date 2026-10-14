// T0: the connector execution contract (ADR-0012 item 1). The shapes compile from contracts with
// zero runtime dependencies; the canonical JSON is stable under key order; a submission missing a
// required field is rejected with a field-specific error; connector responses are checked before
// the Gateway stores them.

import { describe, expect, it } from "vitest";
import {
  CONNECTOR_TOOL_NAMES,
  type ConnectorCapabilities,
  canonicalJson,
  isContentHash,
  isReceiptStatus,
  parseConnectorCapabilities,
  parseConnectorReceipt,
  parseConnectorValidation,
  riskForEffect,
  validateAgainstSchema,
} from "./connector.js";
import { DeskmatesError } from "./errors.js";

const HASH = "a".repeat(64);

const capabilities: ConnectorCapabilities = {
  name: "ticket-db",
  version: "1.0.0",
  operations: [
    { name: "select", effect: "read" },
    { name: "insert", effect: "reversible" },
    { name: "notify", effect: "external" },
  ],
  limits: { maxRows: 100 },
  submissionSchema: {
    type: "object",
    required: ["operation", "statement"],
    properties: {
      operation: { type: "string", enum: ["select", "insert", "notify"] },
      statement: { type: "string" },
      params: { type: "array", items: { type: "number" } },
    },
    additionalProperties: false,
  },
  unsupported: ["transactions spanning submissions"],
};

describe("canonicalJson", () => {
  it("sorts object keys at every depth and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}',
    );
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it("omits undefined members like JSON.stringify and rejects values JSON cannot carry", () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, undefined, () => 1, 1n]) {
      expect(() => canonicalJson(bad)).toThrow(DeskmatesError);
    }
  });
});

describe("effect class and names", () => {
  it("maps read, reversible and external to L0, L1 and L2 (ADR-0012 item 6)", () => {
    expect(riskForEffect("read")).toBe("L0");
    expect(riskForEffect("reversible")).toBe("L1");
    expect(riskForEffect("external")).toBe("L2");
  });

  it("names exactly the five bot-facing tools (ADR-0012 item 3)", () => {
    expect([...CONNECTOR_TOOL_NAMES]).toEqual([
      "connector_describe",
      "connector_validate",
      "connector_submit",
      "connector_status",
      "connector_receipt",
    ]);
  });

  it("knows the receipt status vocabulary and the content hash format", () => {
    for (const s of ["accepted", "running", "succeeded", "failed", "rejected"])
      expect(isReceiptStatus(s)).toBe(true);
    expect(isReceiptStatus("done")).toBe(false);
    expect(isContentHash(HASH)).toBe(true);
    expect(isContentHash("A".repeat(64))).toBe(false);
    expect(isContentHash("abc")).toBe(false);
  });
});

describe("validateAgainstSchema", () => {
  it("accepts a submission that matches the advertised schema", () => {
    expect(
      validateAgainstSchema(capabilities.submissionSchema, {
        operation: "select",
        statement: "SELECT 1",
        params: [1, 2],
      }),
    ).toEqual([]);
  });

  it("rejects a submission missing a required field with a field-specific error", () => {
    const errors = validateAgainstSchema(capabilities.submissionSchema, { operation: "select" });
    expect(errors).toEqual([
      { path: "statement", code: "required", message: "statement is required" },
    ]);
  });

  it("names the field for type, enum and extra-property errors", () => {
    const errors = validateAgainstSchema(capabilities.submissionSchema, {
      operation: "drop",
      statement: 5,
      params: [1, "x"],
      extra: true,
    });
    expect(errors.map((e) => [e.path, e.code])).toEqual([
      ["operation", "enum"],
      ["statement", "type"],
      ["params[1]", "type"],
      ["extra", "additional_property"],
    ]);
  });
});

describe("connector response checks", () => {
  it("accepts a well-formed capabilities document and rejects a bad effect class", () => {
    expect(parseConnectorCapabilities(capabilities)).toEqual(capabilities);
    const bad = { ...capabilities, operations: [{ name: "x", effect: "harmless" }] };
    expect(() => parseConnectorCapabilities(bad)).toThrow(
      expect.objectContaining({ code: "connector_protocol" }),
    );
  });

  it("checks a validation result's hash, effect and errors", () => {
    const ok = {
      validationId: "val-1",
      contentHash: HASH,
      valid: true,
      effect: "read",
      summary: "SELECT on tickets",
      errors: [],
    };
    expect(parseConnectorValidation(ok)).toEqual(ok);
    expect(() => parseConnectorValidation({ ...ok, contentHash: "nope" })).toThrow(
      expect.objectContaining({ code: "connector_protocol" }),
    );
    expect(() => parseConnectorValidation({ ...ok, errors: [{ path: 1 }] })).toThrow(
      expect.objectContaining({ code: "connector_protocol" }),
    );
  });

  it("checks a receipt's status vocabulary and version", () => {
    const ok = {
      receiptId: "rcpt-1",
      status: "accepted",
      version: 1,
      contentHash: HASH,
      validationId: "val-1",
      idempotencyKey: "k",
    };
    expect(parseConnectorReceipt(ok)).toEqual(ok);
    expect(() => parseConnectorReceipt({ ...ok, status: "done" })).toThrow(
      expect.objectContaining({ code: "connector_protocol" }),
    );
    expect(() => parseConnectorReceipt({ ...ok, version: 0 })).toThrow(
      expect.objectContaining({ code: "connector_protocol" }),
    );
  });
});
