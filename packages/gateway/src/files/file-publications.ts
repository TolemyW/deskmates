// Publication records (ADR-0014 amendment A4, decision 24): a verified formal result enters Files
// through exactly one row per (task, path, digest). A retry, a restart or a concurrent identical
// delivery finds that row and writes nothing; a new digest for the same task and path supersedes
// the current row, which is kept as history. Called inside the delivery's transaction.

import type { BotId, RunId, WorkspaceId } from "@deskmates/contracts";
import { newId } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";
import type { VerifiedFile } from "./file-verification.js";

export interface PublishInput {
  workspaceId: WorkspaceId;
  taskId: string;
  deliveryId: string;
  runId: RunId;
  botId: BotId;
  scopeVersion: number;
  publishedAt: string;
  files: Array<VerifiedFile & { label: string }>;
}

/** Returns the ids that were newly published; an already published digest is not repeated. */
export function publishVerifiedFiles(db: GatewayDb, input: PublishInput): string[] {
  const existing = db.prepare(
    "SELECT id, superseded_at FROM file_publications WHERE task_id = ? AND path = ? AND sha256 = ?",
  );
  const restore = db.prepare("UPDATE file_publications SET superseded_at = NULL WHERE id = ?");
  const supersede = db.prepare(`UPDATE file_publications SET superseded_at = ?
    WHERE task_id = ? AND path = ? AND sha256 <> ? AND superseded_at IS NULL`);
  const insert = db.prepare(`INSERT INTO file_publications (id, workspace_id, task_id, delivery_id,
    run_id, bot_id, path, label, size_bytes, sha256, check_kind, checked_at, scope_version,
    published_at) VALUES (@id, @workspaceId, @taskId, @deliveryId, @runId, @botId, @path, @label,
    @sizeBytes, @sha256, @check, @checkedAt, @scopeVersion, @publishedAt)`);
  const published: string[] = [];
  for (const file of input.files) {
    const found = existing.get(input.taskId, file.path, file.sha256) as
      | { id: string; superseded_at: string | null }
      | undefined;
    if (found) {
      // The bytes went back to an earlier published version: that row is current again.
      if (found.superseded_at !== null) {
        supersede.run(input.publishedAt, input.taskId, file.path, file.sha256);
        restore.run(found.id);
      }
      continue;
    }
    supersede.run(input.publishedAt, input.taskId, file.path, file.sha256);
    const id = newId("fpub");
    insert.run({
      id,
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      deliveryId: input.deliveryId,
      runId: input.runId,
      botId: input.botId,
      path: file.path,
      label: file.label,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
      check: file.check,
      checkedAt: file.checkedAt,
      scopeVersion: input.scopeVersion,
      publishedAt: input.publishedAt,
    });
    published.push(id);
  }
  return published;
}
