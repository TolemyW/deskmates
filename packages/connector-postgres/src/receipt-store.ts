// The connector's authoritative receipts, in its own append-only SQLite file. A receipt is created
// `accepted` at submit (version 1); every status change appends a version; statement outcomes are
// appended as they happen. Nothing is ever updated or deleted, so a restart keeps every receipt
// and knows exactly which statements were already sent.
//
// `detail` is a JSON string `{"summary": ..., "cases": [...]}`: the Gateway stores `detail` but
// not extra body fields, so on terminal versions it is how per-statement results reach the bot.

import type { ConnectorReceipt, ReceiptStatus } from "@deskmates/contracts";
import type { ReceiptsDb } from "./db/open-receipts-db.js";
import type { CaseResult, StatementError, StatementResult } from "./statement-result.js";
import type { SqlBatch } from "./submission.js";

export interface ReceiptVersionView {
  version: number;
  status: ReceiptStatus;
  recordedAt: string;
}

/** What /submit, /status and /receipt return: the contract's receipt plus connector extras. */
export interface ReceiptBody extends ConnectorReceipt {
  batchId: string;
  createdAt: string;
  recordedAt: string;
  versions: ReceiptVersionView[];
  /** Final results on terminal versions; the outcomes recorded so far while running. */
  cases: CaseResult[];
}

export interface AcceptInput {
  receiptId: string;
  contentHash: string;
  idempotencyKey: string;
  validationId: string;
  batch: SqlBatch;
  summary: string;
}

interface ReceiptRow {
  receipt_id: string;
  content_hash: string;
  idempotency_key: string;
  validation_id: string;
  batch_id: string;
  batch_json: string;
  created_at: string;
}

interface VersionRow {
  version: number;
  status: ReceiptStatus;
  detail: string;
  result_ref: string | null;
  cases_json: string | null;
  recorded_at: string;
}

const TERMINAL: ReadonlySet<ReceiptStatus> = new Set(["succeeded", "failed", "rejected"]);

export function isTerminal(status: ReceiptStatus): boolean {
  return TERMINAL.has(status);
}

export class ReceiptStore {
  constructor(
    private readonly db: ReceiptsDb,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  findByKey(contentHash: string, idempotencyKey: string): string | undefined {
    const row = this.db
      .prepare("SELECT receipt_id FROM receipts WHERE content_hash = ? AND idempotency_key = ?")
      .get(contentHash, idempotencyKey) as { receipt_id: string } | undefined;
    return row?.receipt_id;
  }

  /** Creates the receipt at version 1, `accepted`. The caller checked `findByKey` first. */
  accept(input: AcceptInput): ReceiptBody {
    const now = this.clock().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO receipts
             (receipt_id, content_hash, idempotency_key, validation_id, batch_id, batch_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.receiptId,
          input.contentHash,
          input.idempotencyKey,
          input.validationId,
          input.batch.batch_id,
          JSON.stringify(input.batch),
          now,
        );
      this.insertVersion(input.receiptId, 1, "accepted", input.summary, undefined, undefined, now);
    })();
    return this.mustGet(input.receiptId);
  }

  /** Appends the next version. Returns the receipt as it now is. */
  appendVersion(
    receiptId: string,
    status: ReceiptStatus,
    summary: string,
    cases?: CaseResult[],
    resultRef?: string,
  ): ReceiptBody {
    this.db.transaction(() => {
      const current = this.db
        .prepare("SELECT MAX(version) AS v FROM receipt_versions WHERE receipt_id = ?")
        .get(receiptId) as { v: number | null };
      if (current.v === null) throw new Error(`no receipt ${receiptId}`);
      this.insertVersion(
        receiptId,
        current.v + 1,
        status,
        summary,
        cases,
        resultRef,
        this.clock().toISOString(),
      );
    })();
    return this.mustGet(receiptId);
  }

  private insertVersion(
    receiptId: string,
    version: number,
    status: ReceiptStatus,
    summary: string,
    cases: CaseResult[] | undefined,
    resultRef: string | undefined,
    recordedAt: string,
  ): void {
    const detail = JSON.stringify(cases ? { summary, cases } : { summary });
    this.db
      .prepare(
        `INSERT INTO receipt_versions
           (receipt_id, version, status, detail, result_ref, cases_json, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receiptId,
        version,
        status,
        detail,
        resultRef ?? null,
        cases ? JSON.stringify(cases) : null,
        recordedAt,
      );
  }

  recordStatement(receiptId: string, caseIndex: number, result: StatementResult): void {
    this.db
      .prepare(
        `INSERT INTO statement_results (receipt_id, case_index, statement_index, result_json, recorded_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(receiptId, caseIndex, result.index, JSON.stringify(result), this.clock().toISOString());
  }

  recordConnectError(receiptId: string, caseIndex: number, error: StatementError): void {
    this.db
      .prepare(
        `INSERT INTO statement_results (receipt_id, case_index, statement_index, result_json, recorded_at)
         VALUES (?, ?, -1, ?, ?)`,
      )
      .run(receiptId, caseIndex, JSON.stringify(error), this.clock().toISOString());
  }

  batchOf(receiptId: string): SqlBatch {
    return JSON.parse(this.row(receiptId).batch_json) as SqlBatch;
  }

  /**
   * The outcomes recorded so far, one entry per case of the batch that has any. A case whose
   * connect failed carries `connectError`; statements not yet recorded are absent.
   */
  recordedCases(receiptId: string): CaseResult[] {
    const batch = this.batchOf(receiptId);
    const rows = this.db
      .prepare(
        `SELECT case_index, statement_index, result_json FROM statement_results
         WHERE receipt_id = ? ORDER BY case_index, statement_index`,
      )
      .all(receiptId) as { case_index: number; statement_index: number; result_json: string }[];
    const cases: CaseResult[] = [];
    for (const row of rows) {
      const caseId = batch.cases[row.case_index]?.id ?? String(row.case_index);
      let entry = cases.find((c) => c.caseId === caseId);
      if (!entry) {
        entry = { caseId, statements: [] };
        cases.push(entry);
      }
      if (row.statement_index === -1)
        entry.connectError = JSON.parse(row.result_json) as StatementError;
      else entry.statements.push(JSON.parse(row.result_json) as StatementResult);
    }
    return cases;
  }

  /** Receipts whose latest version is not terminal: what a restart must finish. */
  unfinished(): { receiptId: string; status: ReceiptStatus }[] {
    return this.db
      .prepare(
        `SELECT v.receipt_id AS receiptId, v.status AS status FROM receipt_versions v
         JOIN (SELECT receipt_id, MAX(version) AS version FROM receipt_versions GROUP BY receipt_id) m
           ON m.receipt_id = v.receipt_id AND m.version = v.version
         WHERE v.status NOT IN ('succeeded', 'failed', 'rejected')
         ORDER BY v.receipt_id`,
      )
      .all() as { receiptId: string; status: ReceiptStatus }[];
  }

  get(receiptId: string): ReceiptBody | undefined {
    const row = this.db.prepare("SELECT * FROM receipts WHERE receipt_id = ?").get(receiptId) as
      | ReceiptRow
      | undefined;
    if (!row) return undefined;
    const versions = this.db
      .prepare(
        `SELECT version, status, detail, result_ref, cases_json, recorded_at
         FROM receipt_versions WHERE receipt_id = ? ORDER BY version`,
      )
      .all(receiptId) as VersionRow[];
    const current = versions[versions.length - 1];
    if (!current) return undefined;
    const cases =
      current.cases_json !== null
        ? (JSON.parse(current.cases_json) as CaseResult[])
        : this.recordedCases(receiptId);
    return {
      receiptId: row.receipt_id,
      status: current.status,
      version: current.version,
      contentHash: row.content_hash,
      validationId: row.validation_id,
      idempotencyKey: row.idempotency_key,
      ...(current.result_ref === null ? {} : { resultRef: current.result_ref }),
      detail: current.detail,
      batchId: row.batch_id,
      createdAt: row.created_at,
      recordedAt: current.recorded_at,
      versions: versions.map((v) => ({
        version: v.version,
        status: v.status,
        recordedAt: v.recorded_at,
      })),
      cases,
    };
  }

  mustGet(receiptId: string): ReceiptBody {
    const body = this.get(receiptId);
    if (!body) throw new Error(`no receipt ${receiptId}`);
    return body;
  }

  private row(receiptId: string): ReceiptRow {
    const row = this.db.prepare("SELECT * FROM receipts WHERE receipt_id = ?").get(receiptId) as
      | ReceiptRow
      | undefined;
    if (!row) throw new Error(`no receipt ${receiptId}`);
    return row;
  }
}
