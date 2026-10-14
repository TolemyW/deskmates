// Optional QA evidence, independent of whether a restart test closed the original app.
import { closeSync, openSync } from "node:fs";
import Database from "better-sqlite3";

export interface LedgerBackupReceipt {
  status: "saved" | "unavailable";
  mode: "open_handle" | "reopened_readonly" | "unknown";
  reason: "source_unavailable" | "output_unavailable" | "backup_failed" | null;
}

export async function backupTestLedger(
  database: Database.Database,
  dbPath: string,
  target: string,
): Promise<LedgerBackupReceipt> {
  let source = database;
  let reopened = false;
  if (!database.open) {
    try {
      source = new Database(dbPath, { readonly: true, fileMustExist: true });
      reopened = true;
    } catch {
      return { status: "unavailable", mode: "unknown", reason: "source_unavailable" };
    }
  }
  const mode = reopened ? "reopened_readonly" : "open_handle";
  try {
    try {
      // Reserve a private destination without replacing a prior receipt.
      closeSync(openSync(target, "wx", 0o600));
    } catch {
      return { status: "unavailable", mode, reason: "output_unavailable" };
    }
    try {
      // SQLite's backup API includes WAL data; copying the database file does not.
      await source.backup(target);
      return { status: "saved", mode, reason: null };
    } catch {
      // Keep any partial output for diagnosis; it is never reported as a usable ledger.
      return { status: "unavailable", mode, reason: "backup_failed" };
    }
  } finally {
    if (reopened) source.close();
  }
}
