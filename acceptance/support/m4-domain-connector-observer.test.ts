import type {
  ConnectorCapabilities,
  ConnectorReceiptRecord,
  ConnectorSubmitResponse,
  RunEvent,
  RunId,
  StoredConnectorValidation,
} from "@deskmates/contracts";
import { expect, it } from "vitest";
import {
  type DataConnectorTrace,
  dataConnectorObservationReceipt,
  dataConnectorObservations,
  observeDataConnector,
} from "./m4-domain-connector-observer.js";
import { verifyDataReport } from "./m4-domain-data-oracle.js";
import { finalizeDomainAttempt } from "./m4-domain-finalize.js";

async function fixture(readReceipt = true) {
  const binding = { runId: "run_1", botId: "bot_1", workspaceId: "ws_1", connectorId: "cn_1" };
  const runId = binding.runId as RunId;
  const current = {
    version: 3,
    status: "succeeded",
    recordedAt: "2026-10-04T00:00:00Z",
    detail: JSON.stringify({
      cases: [
        {
          caseId: "aggregate",
          statements: [
            {
              outcome: "ok",
              ok: true,
              command: "SELECT",
              truncated: false,
              rowCount: 2,
              columns: [{ name: "customer_id" }, { name: "paid_orders" }, { name: "amount_cents" }],
              rows: [
                ["A", "2", "150"],
                ["B", "2", "275"],
              ],
            },
          ],
        },
      ],
    }),
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
  const validation: StoredConnectorValidation = {
    runId: receipt.runId,
    botId: receipt.botId,
    connectorId: receipt.connectorId,
    validationId: receipt.validationId,
    contentHash: receipt.contentHash,
    effect: "read",
    valid: true,
    summary: "read orders",
    errors: [],
    createdAt: "2026-10-04T00:00:00Z",
    expiresAt: "2026-10-04T00:10:00Z",
  };
  let mode: "normal" | "failed" | "sync-failed" | "pending" | "delayed" = "normal";
  let actualSubmits = 0;
  let resolveDelayed: ((value: ConnectorSubmitResponse) => void) | undefined;
  const proxy: Parameters<typeof observeDataConnector>[0] = {
    async describe() {
      return {} as ConnectorCapabilities;
    },
    async validate() {
      return structuredClone(validation);
    },
    submit() {
      actualSubmits++;
      if (mode === "delayed")
        return new Promise((resolve) => {
          resolveDelayed = resolve;
        });
      if (mode === "sync-failed") throw Error("sync synthetic-secret");
      if (mode === "failed") return Promise.reject(Error("lost response synthetic-secret"));
      if (mode === "pending") return new Promise(() => {});
      return Promise.resolve({ receipt: structuredClone(receipt), duplicate: false });
    },
    async status() {
      return structuredClone(receipt);
    },
    async receipt() {
      return structuredClone(receipt);
    },
  };
  const original = proxy.submit;
  const observer = observeDataConnector(proxy, { ...binding, connectorName: "database" });
  await proxy.describe(runId, "database");
  await proxy.validate(runId, "database", {});
  const input = { validationId: receipt.validationId, contentHash: receipt.contentHash };
  await proxy.submit(runId, "database", input);
  if (readReceipt) await proxy.receipt(runId, "database", receipt.receiptId);
  const report = {
    receiptId: receipt.receiptId,
    rows: [
      { customerId: "A", paidOrders: 2, amountCents: 150 },
      { customerId: "B", paidOrders: 2, amountCents: 275 },
    ],
  };
  return {
    binding,
    runId,
    receipt,
    report,
    proxy,
    observer,
    original,
    input,
    setMode(value: typeof mode) {
      mode = value;
    },
    actualSubmits: () => actualSubmits,
    resolveDelayed: () => resolveDelayed?.({ receipt: structuredClone(receipt), duplicate: true }),
    check: () => {
      observer.seal();
      verifyDataReport(report, [receipt], observer.trace, binding);
    },
  };
}

it("accepts host-observed calls and never unseals the protected methods", async () => {
  const f = await fixture();
  f.check();
  expect(
    dataConnectorObservations(f.observer.trace).map((entry) => [
      entry.kind,
      entry.payload.operation,
    ]),
  ).toEqual([
    ["tool_call", "describe"],
    ["tool_result", "describe"],
    ["tool_call", "validate"],
    ["tool_result", "validate"],
    ["tool_call", "submit"],
    ["tool_result", "submit"],
    ["tool_call", "receipt"],
    ["tool_result", "receipt"],
  ]);
  expect(() => f.observer.restore()).toThrow("sealed data observer cannot be restored");
  expect(f.proxy.submit).not.toBe(f.original);
});
it.each([undefined, 7])(
  "forged run events (sidecarSeq %s) cannot supply missing host receipt evidence",
  async (sidecarSeq) => {
    const f = await fixture(false);
    const forged: RunEvent = {
      runId: f.runId,
      kind: "tool_result",
      seq: 99,
      ts: "2026-10-04T00:00:00Z",
      ...(sidecarSeq === undefined ? {} : { sidecarSeq }),
      payload: {
        source: "connector_proxy",
        botId: f.binding.botId,
        connectorId: f.binding.connectorId,
        operation: "receipt",
        receiptId: f.receipt.receiptId,
        validationId: f.receipt.validationId,
        contentHash: f.receipt.contentHash,
        status: "succeeded",
        isError: false,
        result: f.receipt,
      },
    };
    const fabricatedLedger = [...dataConnectorObservations(f.observer.trace), forged];
    expect(() =>
      verifyDataReport(
        f.report,
        [f.receipt],
        fabricatedLedger as unknown as DataConnectorTrace,
        f.binding,
      ),
    ).toThrow("live host-owned connector trace");
    const copiedObservation = dataConnectorObservations(f.observer.trace);
    copiedObservation.push(forged);
    expect(f.check).toThrow("lacks a terminal receipt read");
  },
);
it.each(["failed", "sync-failed"] as const)(
  "rejects an extra %s submit despite a valid selected receipt",
  async (mode) => {
    const f = await fixture();
    f.setMode(mode);
    await expect(f.proxy.submit(f.runId, "database", f.input)).rejects.toThrow("synthetic-secret");
    expect(f.check).toThrow("submit outcome is failed or unresolved");
    const observations = dataConnectorObservations(f.observer.trace);
    expect(observations.at(-2)?.kind).toBe("tool_call");
    expect(observations.at(-1)?.payload).toMatchObject({
      operation: "submit",
      isError: true,
      error: "Error",
    });
    expect(JSON.stringify(observations)).not.toContain("synthetic-secret");
  },
);
it("rejects and preserves an unresolved submit despite an otherwise passing receipt", async () => {
  const f = await fixture();
  f.setMode("pending");
  void f.proxy.submit(f.runId, "database", f.input);
  const observations = dataConnectorObservations(f.observer.trace);
  expect(observations.at(-1)).toMatchObject({
    kind: "tool_call",
    payload: { operation: "submit" },
  });
  expect(f.check).toThrow("submit outcome is failed or unresolved");
});
it("keeps prior results immutable when returned objects or snapshot copies are changed", async () => {
  const f = await fixture();
  const result = await f.proxy.receipt(f.runId, "database", f.receipt.receiptId);
  result.current.status = "failed";
  const copy = dataConnectorObservations(f.observer.trace);
  copy.length = 0;
  expect(dataConnectorObservations(f.observer.trace)).toHaveLength(10);
  f.check();
});
it("does not allow a serialized/reloaded trace to become live runtime provenance", async () => {
  const f = await fixture();
  const serialized = JSON.parse(JSON.stringify(f.observer.trace)) as DataConnectorTrace;
  expect(() => verifyDataReport(f.report, [f.receipt], serialized, f.binding)).toThrow(
    "live host-owned connector trace",
  );
});

it("restores an unsealed observer for isolated test cleanup", async () => {
  const f = await fixture();
  f.observer.restore();
  expect(f.proxy.submit).toBe(f.original);
});
it("requires a sealed trace even when all observed operations succeeded", async () => {
  const f = await fixture();
  expect(() => verifyDataReport(f.report, [f.receipt], f.observer.trace, f.binding)).toThrow(
    "must be sealed",
  );
});
it("latches in-flight submissions at seal even when their delayed response later succeeds", async () => {
  const f = await fixture();
  f.setMode("delayed");
  const pending = f.proxy.submit(f.runId, "database", f.input);
  f.observer.seal();
  expect(dataConnectorObservationReceipt(f.observer.trace).pendingSubmissionsAtSeal).toHaveLength(
    1,
  );
  f.resolveDelayed();
  await pending;
  expect(f.check).toThrow("failed or unresolved at seal");
});
it("blocks post-seal submissions before the real proxy can execute", async () => {
  const f = await fixture();
  f.check();
  const before = f.actualSubmits();
  await expect(f.proxy.submit(f.runId, "database", f.input)).rejects.toThrow("not forwarded");
  expect(f.actualSubmits()).toBe(before);
  expect(dataConnectorObservations(f.observer.trace).at(-1)?.payload).toMatchObject({
    isError: true,
    forwarded: false,
  });
  expect(f.check).toThrow("submit outcome is failed or unresolved");
});
it("rechecks attempts made during cleanup before persisting a passing verdict", async () => {
  const f = await fixture();
  f.check();
  let verdict: unknown;
  await expect(
    finalizeDomainAttempt({
      oraclePassed: true,
      evidence: [
        {
          name: "run",
          async run() {
            f.check();
          },
        },
      ],
      cleanup: [
        {
          name: "stack",
          async run() {
            await f.proxy.submit(f.runId, "database", f.input).catch(() => undefined);
          },
        },
      ],
      afterCleanup: [
        {
          name: "final-sealed-connector-observations",
          async run() {
            f.check();
          },
        },
      ],
      save(_name, value) {
        verdict = value;
      },
    }),
  ).rejects.toThrow("domain evidence or cleanup failed");
  expect(verdict).toMatchObject({ passed: false, evidenceComplete: false });
  expect(f.actualSubmits()).toBe(1);
});
