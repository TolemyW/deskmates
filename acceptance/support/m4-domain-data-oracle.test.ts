import type { ConnectorReceiptRecord, RunEvent } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import {
  verifyDataReportEvidence as verifyDataReport,
  verifyDataSnapshot,
} from "./m4-domain-data-oracle.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw Error("test fixture entry missing");
  return value;
}

// Independent offline fixtures. Passing them proves the evaluator's checks, not a T3 run.
function snapshot() {
  return {
    rows: [
      [1, "A", 100, "paid"],
      [2, "A", 50, "paid"],
      [3, "B", 200, "paid"],
      [4, "B", 300, "pending"],
      [5, "A", 25, "refunded"],
      [6, "B", 75, "paid"],
    ],
    columns: [
      ["orders_fixture", "id", "integer", "NO"],
      ["orders_fixture", "customer_id", "text", "YES"],
      ["orders_fixture", "amount_cents", "integer", "YES"],
      ["orders_fixture", "status", "text", "YES"],
    ],
    constraints: [["orders_fixture", "orders_fixture_pkey", "PRIMARY KEY (id)"]],
  };
}

function fixture() {
  const binding = { runId: "run_1", botId: "bot_1", workspaceId: "ws_1", connectorId: "cn_1" };
  const report = {
    receiptId: "rcpt_1",
    rows: [
      { customerId: "A", paidOrders: 2, amountCents: 150 },
      { customerId: "B", paidOrders: 2, amountCents: 275 },
    ],
  };
  const statement = {
    index: 0,
    sql: "SELECT customer_id, COUNT(*) AS paid_orders, SUM(amount_cents) AS amount_cents FROM orders_fixture WHERE status='paid' GROUP BY customer_id ORDER BY customer_id",
    ok: true,
    outcome: "ok",
    command: "SELECT",
    rowCount: 2,
    truncated: false,
    durationMs: 1,
    columns: [
      { name: "customer_id", typeOid: 25 },
      { name: "paid_orders", typeOid: 20 },
      { name: "amount_cents", typeOid: 20 },
    ],
    rows: [
      ["A", "2", "150"],
      ["B", "2", "275"],
    ],
  };
  const current = {
    version: 3,
    status: "succeeded",
    recordedAt: "2026-10-04T00:00:00Z",
    detail: JSON.stringify({ cases: [{ caseId: "aggregate", statements: [statement] }] }),
  };
  const receipt = {
    ...binding,
    receiptId: "rcpt_1",
    contentHash: "a".repeat(64),
    validationId: "val_1",
    idempotencyKey: "val_1",
    current,
    versions: [current],
  } as ConnectorReceiptRecord;
  const event = (
    seq: number,
    operation: string,
    fields: Record<string, unknown> = {},
  ): RunEvent => ({
    runId: receipt.runId,
    seq,
    kind: "tool_result",
    ts: "2026-10-04T00:00:00Z",
    payload: {
      source: "connector_proxy",
      connectorId: binding.connectorId,
      botId: binding.botId,
      operation,
      isError: false,
      ...fields,
    },
  });
  const ids = { validationId: receipt.validationId, contentHash: receipt.contentHash };
  const events = [
    event(1, "describe", { result: {} }),
    event(2, "validate", {
      ...ids,
      valid: true,
      effect: "read",
      result: { ...binding, ...ids, valid: true, effect: "read" },
    }),
    event(3, "submit", {
      ...ids,
      receiptId: receipt.receiptId,
      idempotencyKey: receipt.idempotencyKey,
      duplicate: false,
      result: { receipt: structuredClone(receipt), duplicate: false },
    }),
    event(4, "receipt", {
      ...ids,
      receiptId: receipt.receiptId,
      status: "succeeded",
      result: structuredClone(receipt),
    }),
  ];
  const receipts = [receipt];
  return {
    binding,
    report,
    statement,
    receipt,
    receipts,
    events,
    check: () => verifyDataReport(report, receipts, events, binding),
    setStatement: (value: unknown) => {
      receipt.current.detail = JSON.stringify({
        cases: [{ caseId: "aggregate", statements: [value] }],
      });
      const read = events.at(-1);
      if (read) read.payload.result = structuredClone(receipt);
    },
  };
}

describe("independent data seed oracle", () => {
  it("binds six exact seeded rows, including excluded statuses, to a stable checksum", () => {
    const first = verifyDataSnapshot(snapshot());
    expect(first.rowCount).toBe(6);
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyDataSnapshot(JSON.parse(JSON.stringify(snapshot())))).toEqual(first);
  });
  it("rejects offsetting writes even when paid aggregates remain unchanged", () => {
    const value = snapshot();
    required(value.rows[0])[2] = 101;
    required(value.rows[1])[2] = 49;
    expect(() => verifyDataSnapshot(value)).toThrow("seed rows changed");
  });
  it("rejects changes to excluded rows", () => {
    const value = snapshot();
    required(value.rows[3])[2] = 301;
    expect(() => verifyDataSnapshot(value)).toThrow("seed rows changed");
  });
  it("rejects missing rows, columns, and primary-key constraints", () => {
    for (const key of ["rows", "columns", "constraints"] as const) {
      const value = snapshot();
      value[key].pop();
      expect(() => verifyDataSnapshot(value)).toThrow();
    }
  });
  it("rejects an off-task table", () => {
    const value = snapshot();
    value.columns.push(["other_table", "id", "integer", "YES"]);
    expect(() => verifyDataSnapshot(value)).toThrow("schema columns changed");
  });
});

describe("data report receipt and ledger oracle", () => {
  it("accepts exact aggregates with an attributed read-only submission and terminal read", () => {
    fixture().check();
  });
  it("compares report object keys semantically", () => {
    const f = fixture();
    f.report.rows = [
      { amountCents: 150, paidOrders: 2, customerId: "A" },
      { amountCents: 275, paidOrders: 2, customerId: "B" },
    ];
    f.check();
  });
  it.each(["runId", "botId", "workspaceId", "connectorId"] as const)(
    "rejects wrong receipt %s",
    (key) => {
      const f = fixture();
      Object.assign(f.receipt, { [key]: "wrong" });
      expect(f.check).toThrow();
    },
  );
  it.each(["runId", "botId", "connectorId"])("rejects wrong ledger %s", (key) => {
    const f = fixture();
    if (key === "runId") Object.assign(required(f.events[0]), { runId: "wrong" });
    else required(f.events[0]).payload[key] = "wrong";
    expect(f.check).toThrow("attribution mismatch");
  });
  it.each(["describe", "validate", "submit", "receipt"])(
    "requires successful %s evidence",
    (operation) => {
      const f = fixture();
      required(f.events.find((event) => event.payload.operation === operation)).payload.isError =
        true;
      expect(f.check).toThrow();
    },
  );
  it("does not trust sidecar tool names without authoritative proxy outcomes", () => {
    const f = fixture();
    for (const event of f.events) {
      event.payload.toolName = `mcp__deskmates__connector_${event.payload.operation}`;
      event.payload.source = undefined;
    }
    expect(f.check).toThrow("original submission");
  });
  it.each(["contentHash", "validationId", "idempotencyKey"])(
    "rejects mismatched submit %s",
    (key) => {
      const f = fixture();
      required(f.events[2]).payload[key] = "wrong";
      expect(f.check).toThrow("binding mismatch");
    },
  );
  it("rejects validation for another run despite matching summary fields", () => {
    const f = fixture();
    (required(f.events[1]).payload.result as Record<string, unknown>).runId = "other";
    expect(f.check).toThrow("validation result binding mismatch");
  });
  it("rejects external validation even if the final aggregates look right", () => {
    const f = fixture();
    required(f.events[1]).payload.effect = "external";
    expect(f.check).toThrow("read-only validation");
  });
  it("requires validation before submission and receipt read after submission", () => {
    for (const index of [1, 3]) {
      const f = fixture();
      required(f.events[index]).seq = index === 1 ? 5 : 0;
      expect(f.check).toThrow();
    }
  });
  it("requires the exact authoritative terminal result, not an earlier accepted version", () => {
    const f = fixture();
    const observed = required(f.events[3]).payload.result as ConnectorReceiptRecord;
    observed.current.status = "accepted";
    expect(f.check).toThrow("terminal receipt read differs");
  });
  it("allows idempotent duplicate submits while counting only one original", () => {
    const f = fixture();
    const duplicate = structuredClone(required(f.events[2]));
    duplicate.seq = 5;
    duplicate.payload.duplicate = true;
    (duplicate.payload.result as Record<string, unknown>).duplicate = true;
    f.events.push(duplicate);
    f.check();
  });
  it("rejects duplicate execution and duplicate retained receipt ids", () => {
    const f = fixture();
    f.events.push({ ...structuredClone(required(f.events[2])), seq: 5 });
    expect(f.check).toThrow("exactly one original submission");
    f.events.pop();
    f.receipts.push(structuredClone(f.receipt));
    expect(f.check).toThrow("receipt ids are duplicated");
  });
  it("rejects a successful submission without a retained receipt", () => {
    const f = fixture();
    required(f.events[2]).payload.receiptId = "lost";
    expect(f.check).toThrow("no retained receipt");
  });
  it.each(["accepted", "running", "failed"] as const)("rejects %s receipts", (status) => {
    const f = fixture();
    f.receipt.current.status = status;
    expect(f.check).toThrow("unfinished or failed work");
  });
  it.each(["uncertain", "not_run", "error"])(
    "rejects %s statements despite a succeeded receipt",
    (outcome) => {
      const f = fixture();
      f.setStatement({ ...f.statement, outcome, ok: false });
      expect(f.check).toThrow();
    },
  );
  it.each([
    { command: "UPDATE" },
    { rowCount: 3 },
    { truncated: true },
    { truncated: undefined },
    { columns: [{ name: "wrong" }] },
    { rows: [["A", "2", "150"]] },
  ])("rejects incomplete or mismatched result metadata %j", (patch) => {
    const f = fixture();
    f.setStatement({ ...f.statement, ...patch });
    expect(f.check).toThrow();
  });
  it("rejects empty/malformed case details and missing report receipts", () => {
    for (const detail of [
      "null",
      "{}",
      '{"cases":[]}',
      '{"cases":[{"statements":[]}]}',
      "bad-json",
    ]) {
      const f = fixture();
      f.receipt.current.detail = detail;
      expect(f.check).toThrow();
    }
    const f = fixture();
    f.report.receiptId = "unrelated";
    expect(f.check).toThrow("absent from this run");
  });
  it("rejects constant, reordered and string-valued report aggregates", () => {
    for (const rows of [
      [{ customerId: "A", paidOrders: 2, amountCents: 150 }],
      [...fixture().report.rows].reverse(),
      [{ customerId: "A", paidOrders: "2", amountCents: 150 }],
    ]) {
      const f = fixture();
      Object.assign(f.report, { rows });
      expect(f.check).toThrow("reported aggregates differ");
    }
  });
  it("rejects a returned submit receipt for another owner", () => {
    const f = fixture();
    const result = required(f.events[2]).payload.result as { receipt: ConnectorReceiptRecord };
    Object.assign(result.receipt, { workspaceId: "other" });
    expect(f.check).toThrow("submit receipt owner mismatch");
  });
  it("accepts a later exact terminal read after an earlier stale receipt version", () => {
    const f = fixture();
    const later = { ...structuredClone(required(f.events[3])), seq: 5 };
    const stale = required(f.events[3]).payload.result as ConnectorReceiptRecord;
    stale.current.version = 2;
    f.events.push(later);
    f.check();
  });
  it("retains a definite exploratory error receipt without mistaking it for the final report", () => {
    const f = fixture();
    const earlier = structuredClone(f.receipt);
    earlier.receiptId = "rcpt_error";
    earlier.validationId = "val_error";
    earlier.idempotencyKey = "val_error";
    earlier.contentHash = "b".repeat(64);
    earlier.current.detail = JSON.stringify({
      cases: [
        {
          caseId: "explore",
          statements: [
            {
              index: 0,
              sql: "SELECT missing FROM orders_fixture",
              ok: false,
              outcome: "error",
              durationMs: 1,
              error: { sqlstate: "42703", message: "column missing does not exist" },
            },
          ],
        },
      ],
    });
    const validation = structuredClone(required(f.events[1]));
    validation.seq = 5;
    const ids = { validationId: earlier.validationId, contentHash: earlier.contentHash };
    Object.assign(validation.payload, ids);
    Object.assign(validation.payload.result as object, ids);
    const submit = structuredClone(required(f.events[2]));
    submit.seq = 6;
    Object.assign(submit.payload, ids, {
      receiptId: earlier.receiptId,
      idempotencyKey: earlier.idempotencyKey,
      result: { receipt: structuredClone(earlier), duplicate: false },
    });
    f.events.push(validation, submit);
    f.receipts.push(earlier);
    f.check();
    earlier.current.detail = earlier.current.detail.replace('"error"', '"uncertain"');
    expect(f.check).toThrow("uncertain statement");
  });
});
