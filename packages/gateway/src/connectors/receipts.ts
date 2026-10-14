// Authoritative receipts (ADR-0012 item 4). One header row per accepted submission, one immutable
// row per receipt version; triggers in 0016 refuse any UPDATE or DELETE. A newer version from the
// connector is appended, an older or equal one is ignored, so replays never rewrite history.

import type {
  BotId,
  ConnectorId,
  ConnectorReceipt,
  ConnectorReceiptRecord,
  ReceiptStatus,
  ReceiptVersion,
  RunId,
  WorkspaceId,
} from "@deskmates/contracts";
import type { GatewayDb } from "../db/open.js";

export interface ReceiptOwner {
  connectorId: ConnectorId;
  workspaceId: WorkspaceId;
  runId: RunId;
  botId: BotId;
}

interface HeaderRow {
  connector_id: string;
  receipt_id: string;
  workspace_id: string;
  run_id: string;
  bot_id: string;
  content_hash: string;
  validation_id: string;
  idempotency_key: string;
  created_at: string;
}

interface VersionRow {
  version: number;
  status: string;
  result_ref: string | null;
  detail: string | null;
  recorded_at: string;
}

function toVersion(row: VersionRow): ReceiptVersion {
  return {
    version: row.version,
    status: row.status as ReceiptStatus,
    ...(row.result_ref === null ? {} : { resultRef: row.result_ref }),
    ...(row.detail === null ? {} : { detail: row.detail }),
    recordedAt: row.recorded_at,
  };
}

export class ReceiptStore {
  constructor(
    private readonly db: GatewayDb,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Stores a new receipt and its first version in one transaction. */
  create(owner: ReceiptOwner, receipt: ConnectorReceipt): ConnectorReceiptRecord {
    const now = this.clock().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO connector_receipts
             (connector_id, receipt_id, workspace_id, run_id, bot_id, content_hash, validation_id,
              idempotency_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          owner.connectorId,
          receipt.receiptId,
          owner.workspaceId,
          owner.runId,
          owner.botId,
          receipt.contentHash,
          receipt.validationId,
          receipt.idempotencyKey,
          now,
        );
      this.insertVersion(owner.connectorId, receipt, now);
    })();
    return this.mustGet(owner.connectorId, receipt.receiptId);
  }

  /** Appends the connector's version when it is newer than the latest stored one. */
  addVersionIfNewer(connectorId: ConnectorId, receipt: ConnectorReceipt): ConnectorReceiptRecord {
    this.db.transaction(() => {
      const current = this.latestVersion(connectorId, receipt.receiptId);
      if (current === undefined || receipt.version > current)
        this.insertVersion(connectorId, receipt, this.clock().toISOString());
    })();
    return this.mustGet(connectorId, receipt.receiptId);
  }

  get(connectorId: ConnectorId, receiptId: string): ConnectorReceiptRecord | undefined {
    const header = this.db
      .prepare("SELECT * FROM connector_receipts WHERE connector_id = ? AND receipt_id = ?")
      .get(connectorId, receiptId) as HeaderRow | undefined;
    return header ? this.toRecord(header) : undefined;
  }

  mustGet(connectorId: ConnectorId, receiptId: string): ConnectorReceiptRecord {
    const r = this.get(connectorId, receiptId);
    if (!r) throw new Error(`receipt ${receiptId} of ${connectorId} vanished inside a transaction`);
    return r;
  }

  /** The receipt a repeated submit returns instead of executing again (ADR-0012 item 5). */
  findByIdempotency(
    connectorId: ConnectorId,
    contentHash: string,
    idempotencyKey: string,
  ): ConnectorReceiptRecord | undefined {
    const header = this.db
      .prepare(
        "SELECT * FROM connector_receipts WHERE connector_id = ? AND content_hash = ? AND idempotency_key = ?",
      )
      .get(connectorId, contentHash, idempotencyKey) as HeaderRow | undefined;
    return header ? this.toRecord(header) : undefined;
  }

  listForRun(runId: RunId): ConnectorReceiptRecord[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM connector_receipts WHERE run_id = ? ORDER BY created_at, receipt_id",
        )
        .all(runId) as HeaderRow[]
    ).map((h) => this.toRecord(h));
  }

  listForConnector(connectorId: ConnectorId): ConnectorReceiptRecord[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM connector_receipts WHERE connector_id = ? ORDER BY created_at, receipt_id",
        )
        .all(connectorId) as HeaderRow[]
    ).map((h) => this.toRecord(h));
  }

  private latestVersion(connectorId: ConnectorId, receiptId: string): number | undefined {
    const row = this.db
      .prepare(
        "SELECT MAX(version) AS v FROM connector_receipt_versions WHERE connector_id = ? AND receipt_id = ?",
      )
      .get(connectorId, receiptId) as { v: number | null };
    return row.v ?? undefined;
  }

  private insertVersion(connectorId: ConnectorId, receipt: ConnectorReceipt, at: string): void {
    this.db
      .prepare(
        `INSERT INTO connector_receipt_versions
           (connector_id, receipt_id, version, status, result_ref, detail, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        connectorId,
        receipt.receiptId,
        receipt.version,
        receipt.status,
        receipt.resultRef ?? null,
        receipt.detail ?? null,
        at,
      );
  }

  private toRecord(h: HeaderRow): ConnectorReceiptRecord {
    const versions = (
      this.db
        .prepare(
          "SELECT version, status, result_ref, detail, recorded_at FROM connector_receipt_versions WHERE connector_id = ? AND receipt_id = ? ORDER BY version",
        )
        .all(h.connector_id, h.receipt_id) as VersionRow[]
    ).map(toVersion);
    const current = versions[versions.length - 1];
    if (!current) throw new Error(`receipt ${h.receipt_id} has no version`);
    return {
      receiptId: h.receipt_id,
      connectorId: h.connector_id as ConnectorId,
      workspaceId: h.workspace_id as WorkspaceId,
      runId: h.run_id as RunId,
      botId: h.bot_id as BotId,
      contentHash: h.content_hash,
      validationId: h.validation_id,
      idempotencyKey: h.idempotency_key,
      current,
      versions,
    };
  }
}
