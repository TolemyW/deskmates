// Host-only independent data oracle. Neither these answer keys nor database snapshots are
// copied into the workspace. Pure offline tests exercise rejection, not model acceptance.
import { createHash } from "node:crypto";
import { type ConnectorReceiptRecord, type RunEvent, canonicalJson } from "@deskmates/contracts";

import {
  type DataConnectorTrace,
  dataConnectorObservations,
  requireSettledDataSubmissions,
} from "./m4-domain-connector-observer.js";

export const DATA_ROWS = [
  { customerId: "A", paidOrders: 2, amountCents: 150 },
  { customerId: "B", paidOrders: 2, amountCents: 275 },
];

const SEED_ROWS = [
  [1, "A", 100, "paid"],
  [2, "A", 50, "paid"],
  [3, "B", 200, "paid"],
  [4, "B", 300, "pending"],
  [5, "A", 25, "refunded"],
  [6, "B", 75, "paid"],
];
const SEED_COLUMNS = [
  ["orders_fixture", "id", "integer", "NO"],
  ["orders_fixture", "customer_id", "text", "YES"],
  ["orders_fixture", "amount_cents", "integer", "YES"],
  ["orders_fixture", "status", "text", "YES"],
];

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw Error("data oracle expected an object");
  return value as Record<string, unknown>;
}

function same(actual: unknown, expected: unknown, label: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw Error(`data oracle ${label}`);
}

/** Includes non-paid rows: aggregate-preserving or off-task changes must still fail. */
export function verifyDataSnapshot(value: unknown): { rowCount: number; sha256: string } {
  const snapshot = object(value);
  same(snapshot.rows, SEED_ROWS, "seed rows changed");
  same(snapshot.columns, SEED_COLUMNS, "schema columns changed");
  same(
    snapshot.constraints,
    [["orders_fixture", "orders_fixture_pkey", "PRIMARY KEY (id)"]],
    "schema constraints changed",
  );
  return {
    rowCount: SEED_ROWS.length,
    sha256: createHash("sha256").update(canonicalJson(snapshot)).digest("hex"),
  };
}

export interface DataRunBinding {
  runId: string;
  botId: string;
  workspaceId: string;
  connectorId: string;
}

function checkOwner(receipt: ConnectorReceiptRecord, binding: DataRunBinding): void {
  for (const key of ["runId", "botId", "workspaceId", "connectorId"] as const)
    if (receipt[key] !== binding[key]) throw Error(`data receipt ${key} mismatch`);
}

function statements(receipt: ConnectorReceiptRecord): Record<string, unknown>[] {
  const detail = object(JSON.parse(receipt.current.detail ?? "null"));
  if (!Array.isArray(detail.cases) || detail.cases.length === 0)
    throw Error("data receipt has no cases");
  return detail.cases.flatMap((entry) => {
    const item = object(entry);
    if (
      item.connectError !== undefined ||
      !Array.isArray(item.statements) ||
      !item.statements.length
    )
      throw Error("data receipt has incomplete case coverage");
    return item.statements.map(object);
  });
}

/** Runtime entry point: persisted run events are not provenance and cannot supply this handle. */
export function verifyDataReport(
  value: unknown,
  receipts: readonly ConnectorReceiptRecord[],
  trace: DataConnectorTrace,
  binding: DataRunBinding,
): void {
  requireSettledDataSubmissions(trace);
  verifyDataReportEvidence(value, receipts, dataConnectorObservations(trace), binding);
}

/** Pure evaluator for offline adversarial tests; this does not authenticate supplied evidence.
 * Runtime callers must use verifyDataReport with its host-owned observer handle.
 * Verify the authoritative receipt and ordered host-observed calls, never ledger tool names alone.
 * All successful submissions are reconciled, including duplicates and abandoned receipts.
 * Definite exploratory SQL errors may precede recovery; uncertain/pending work may not.
 */
export function verifyDataReportEvidence(
  value: unknown,
  receipts: readonly ConnectorReceiptRecord[],
  events: readonly RunEvent[],
  binding: DataRunBinding,
): void {
  const report = object(value);
  same(report.rows, DATA_ROWS, "reported aggregates differ");
  if (typeof report.receiptId !== "string" || report.receiptId.length === 0)
    throw Error("data report needs a receipt id");
  if (new Set(receipts.map((receipt) => receipt.receiptId)).size !== receipts.length)
    throw Error("data receipt ids are duplicated");
  const selected = receipts.find((receipt) => receipt.receiptId === report.receiptId);
  if (!selected) throw Error("data report receipt is absent from this run");
  const proxy = events.filter((event) => event.payload.source === "connector_proxy");
  for (const event of proxy) {
    if (
      event.runId !== binding.runId ||
      event.payload.botId !== binding.botId ||
      event.payload.connectorId !== binding.connectorId
    )
      throw Error("data connector event attribution mismatch");
  }
  if (
    new Set(proxy.map((event) => event.seq)).size !== proxy.length ||
    proxy.some((event) => !Number.isSafeInteger(event.seq) || event.seq <= 0)
  )
    throw Error("data connector event sequence is invalid");
  const successful = proxy.filter(
    (event) => event.kind === "tool_result" && event.payload.isError === false,
  );
  const submitted = successful.filter((event) => event.payload.operation === "submit");
  for (const event of submitted) {
    const receipt = receipts.find((item) => item.receiptId === event.payload.receiptId);
    if (!receipt) throw Error("data submit has no retained receipt");
    const result = object(event.payload.result);
    const observed = object(result.receipt);
    for (const key of ["receiptId", "contentHash", "validationId", "idempotencyKey"] as const)
      if (event.payload[key] !== receipt[key] || observed[key] !== receipt[key])
        throw Error("data submit receipt binding mismatch");
    for (const key of ["runId", "botId", "workspaceId", "connectorId"] as const)
      if (observed[key] !== receipt[key]) throw Error("data submit receipt owner mismatch");
    if (
      typeof event.payload.duplicate !== "boolean" ||
      result.duplicate !== event.payload.duplicate
    )
      throw Error("data submit duplicate accounting is unknown");
  }
  for (const receipt of receipts) {
    checkOwner(receipt, binding);
    if (
      !/^[a-f0-9]{64}$/.test(receipt.contentHash) ||
      !receipt.validationId ||
      !receipt.idempotencyKey
    )
      throw Error("data receipt submission identity is missing");
    if (receipt.current.status !== "succeeded")
      throw Error("data receipt has unfinished or failed work");
    const fresh = submitted.filter(
      (event) => event.payload.receiptId === receipt.receiptId && event.payload.duplicate === false,
    );
    if (fresh.length !== 1) throw Error("data receipt needs exactly one original submission");
    const submit = fresh[0];
    if (!submit) throw Error("data original submission missing");
    const validation = successful.find(
      (event) =>
        event.payload.operation === "validate" &&
        event.payload.validationId === receipt.validationId &&
        event.payload.contentHash === receipt.contentHash &&
        event.payload.valid === true &&
        event.payload.effect === "read" &&
        event.seq < submit.seq,
    );
    if (!validation) throw Error("data receipt lacks prior read-only validation");
    const validated = object(validation.payload.result);
    for (const key of ["validationId", "contentHash", "runId", "botId", "connectorId"] as const)
      if (validated[key] !== receipt[key]) throw Error("data validation result binding mismatch");
    if (validated.valid !== true || validated.effect !== "read")
      throw Error("data validation is not read-only");
    if (
      !successful.some(
        (event) => event.payload.operation === "describe" && event.seq < validation.seq,
      )
    )
      throw Error("data receipt lacks prior connector description");
    for (const statement of statements(receipt)) {
      if (!["ok", "error"].includes(String(statement.outcome)))
        throw Error("data receipt contains an uncertain statement");
      if (
        statement.outcome === "ok" &&
        !["SELECT", "SHOW", "EXPLAIN"].includes(String(statement.command))
      )
        throw Error("data receipt contains a write command");
    }
  }
  const rows = statements(selected);
  if (
    rows.some(
      (row) =>
        row.outcome !== "ok" ||
        row.ok !== true ||
        row.truncated !== false ||
        row.error !== undefined,
    )
  )
    throw Error("data selected receipt contains failed or incomplete results");
  const aggregateRows = [
    ["A", "2", "150"],
    ["B", "2", "275"],
  ];
  if (
    !rows.some(
      (row) =>
        row.command === "SELECT" &&
        row.rowCount === 2 &&
        Array.isArray(row.columns) &&
        canonicalJson(row.columns.map((column) => object(column).name)) ===
          canonicalJson(["customer_id", "paid_orders", "amount_cents"]) &&
        canonicalJson(row.rows) === canonicalJson(aggregateRows),
    )
  )
    throw Error("data selected receipt has no exact aggregate result");
  const reads = successful.filter(
    (event) =>
      event.payload.operation === "receipt" &&
      event.payload.receiptId === selected.receiptId &&
      event.payload.contentHash === selected.contentHash &&
      event.payload.validationId === selected.validationId &&
      event.payload.status === "succeeded" &&
      event.seq >
        Math.max(
          ...submitted
            .filter(
              (entry) =>
                entry.payload.receiptId === selected.receiptId && entry.payload.duplicate === false,
            )
            .map((entry) => entry.seq),
        ),
  );
  if (!reads.length) throw Error("data report lacks a terminal receipt read");
  // A call made before completion or for another receipt cannot stand in for reading this result.
  if (!reads.some((read) => canonicalJson(read.payload.result) === canonicalJson(selected)))
    throw Error("data terminal receipt read differs from the retained receipt");
}
