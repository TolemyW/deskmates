// Upload sessions (ADR-0014 amendment A5 decisions 31 and 33). One row per session; the bytes live
// in the workspace container, never here. The routes in `api/file-upload-routes.ts` drive the
// container command; this module only records what the command confirmed.

import type { IsoTimestamp, WorkspaceId, WorkspaceUpload } from "@deskmates/contracts";
import { newId, nowIso } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";

interface UploadRow {
  id: string;
  workspace_id: string;
  uploader: string;
  uploader_user_id: string | null;
  name: string;
  label: string;
  size_bytes: number;
  received_bytes: number;
  state: WorkspaceUpload["state"];
  path: string | null;
  sha256: string | null;
  idempotency_key: string | null;
  failure: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface NewUpload {
  workspaceId: WorkspaceId;
  uploader: string;
  uploaderUserId?: string;
  name: string;
  label: string;
  sizeBytes: number;
  idempotencyKey?: string;
}

function toUpload(row: UploadRow): WorkspaceUpload {
  return {
    id: row.id,
    workspaceId: row.workspace_id as WorkspaceId,
    state: row.state,
    name: row.name,
    label: row.label,
    sizeBytes: row.size_bytes,
    receivedBytes: row.received_bytes,
    uploader: row.uploader,
    ...(row.path === null ? {} : { path: row.path }),
    ...(row.sha256 === null ? {} : { sha256: row.sha256 }),
    createdAt: row.created_at as IsoTimestamp,
    updatedAt: row.updated_at as IsoTimestamp,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at as IsoTimestamp }),
  };
}

export class WorkspaceUploads {
  constructor(private readonly db: GatewayDb) {}

  get(workspaceId: WorkspaceId, id: string): WorkspaceUpload | undefined {
    const row = this.db
      .prepare("SELECT * FROM workspace_uploads WHERE workspace_id = ? AND id = ?")
      .get(workspaceId, id) as UploadRow | undefined;
    return row ? toUpload(row) : undefined;
  }

  byIdempotencyKey(workspaceId: WorkspaceId, key: string): WorkspaceUpload | undefined {
    const row = this.db
      .prepare("SELECT * FROM workspace_uploads WHERE workspace_id = ? AND idempotency_key = ?")
      .get(workspaceId, key) as UploadRow | undefined;
    return row ? toUpload(row) : undefined;
  }

  /** Declared bytes of the workspace's receiving and completed uploads (decision 30 quota). */
  reservedBytes(workspaceId: WorkspaceId): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(size_bytes), 0) AS total FROM workspace_uploads
          WHERE workspace_id = ? AND state IN ('receiving', 'completed')`,
      )
      .get(workspaceId) as { total: number };
    return row.total;
  }

  create(input: NewUpload): WorkspaceUpload {
    const id = newId("upl");
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO workspace_uploads (id, workspace_id, uploader, uploader_user_id, name, label,
           size_bytes, received_bytes, state, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'receiving', ?, ?, ?)`,
      )
      .run(
        id,
        input.workspaceId,
        input.uploader,
        input.uploaderUserId ?? null,
        input.name,
        input.label,
        input.sizeBytes,
        input.idempotencyKey ?? null,
        at,
        at,
      );
    return this.get(input.workspaceId, id) as WorkspaceUpload;
  }

  /** Remove a session whose partial file could not be created; nothing else refers to it. */
  discard(workspaceId: WorkspaceId, id: string): void {
    this.db
      .prepare(
        "DELETE FROM workspace_uploads WHERE workspace_id = ? AND id = ? AND state = 'receiving'",
      )
      .run(workspaceId, id);
  }

  /** Record the length the container confirmed; a failure reason is kept until the next part. */
  setReceived(workspaceId: WorkspaceId, id: string, receivedBytes: number, failure?: string): void {
    this.db
      .prepare(
        `UPDATE workspace_uploads SET received_bytes = ?, failure = ?, updated_at = ?
          WHERE workspace_id = ? AND id = ? AND state = 'receiving'`,
      )
      .run(receivedBytes, failure ?? null, nowIso(), workspaceId, id);
  }

  complete(
    workspaceId: WorkspaceId,
    id: string,
    result: { path: string; sha256: string; sizeBytes: number },
  ): WorkspaceUpload {
    const at = nowIso();
    this.db
      .prepare(
        `UPDATE workspace_uploads
            SET state = 'completed', path = ?, sha256 = ?, received_bytes = ?, failure = NULL,
                completed_at = ?, updated_at = ?
          WHERE workspace_id = ? AND id = ? AND state = 'receiving'`,
      )
      .run(result.path, result.sha256, result.sizeBytes, at, at, workspaceId, id);
    return this.get(workspaceId, id) as WorkspaceUpload;
  }

  end(workspaceId: WorkspaceId, id: string, state: "cancelled" | "expired"): void {
    this.db
      .prepare(
        `UPDATE workspace_uploads SET state = ?, updated_at = ?
          WHERE workspace_id = ? AND id = ? AND state = 'receiving'`,
      )
      .run(state, nowIso(), workspaceId, id);
  }

  /** Receiving sessions idle since before `cutoff` (decision 31). */
  idleSince(workspaceId: WorkspaceId, cutoff: IsoTimestamp): WorkspaceUpload[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM workspace_uploads
            WHERE workspace_id = ? AND state = 'receiving' AND updated_at < ?
            ORDER BY updated_at`,
        )
        .all(workspaceId, cutoff) as UploadRow[]
    ).map(toUpload);
  }
}
