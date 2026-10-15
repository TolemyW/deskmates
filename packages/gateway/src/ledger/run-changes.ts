// What one run changed beyond its own row (issue #11, ADR-0042 decision 4): the task checkpoints
// it wrote, the task artifacts it delivered and the learned-memory entries whose source it is.
// The run's approvals come from `ApprovalStore.forRun`; its summary (`learned`, `filesChanged`,
// `sitesVisited`) and frozen configuration are already on the run row the drawer has.

import type {
  BotId,
  MemoryAuthority,
  MemoryEntryKind,
  MemoryScope,
  MemoryTrust,
  RunId,
  RunMemoryWrite,
  RunTaskArtifact,
  RunTaskCheckpoint,
  ThreadId,
} from "@deskmates/contracts";
import { parseJson } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";

/** At most this many rows of each kind; a run that wrote more says so through the cap. */
export const RUN_CHANGES_LIMIT = 200;

interface MemoryWriteRow {
  id: string;
  scope: Exclude<MemoryScope, "rule">;
  kind: MemoryEntryKind;
  bot_id: string | null;
  thread_id: string | null;
  body: string;
  authority: MemoryAuthority;
  trust: MemoryTrust;
  version: number;
  tombstoned: number;
  consolidated_by_run: string | null;
}

export function runTaskCheckpoints(db: GatewayDb, runId: RunId): RunTaskCheckpoint[] {
  const rows = db
    .prepare(
      `SELECT id, task_id, attempt, body_json, created_at FROM task_checkpoints
        WHERE run_id = ? ORDER BY created_at, id LIMIT ${RUN_CHANGES_LIMIT}`,
    )
    .all(runId) as {
    id: string;
    task_id: string;
    attempt: number;
    body_json: string;
    created_at: string;
  }[];
  return rows.map((row) => ({
    id: row.id,
    taskId: row.task_id,
    attempt: row.attempt,
    body: parseJson<Record<string, unknown>>(row.body_json, {}),
    createdAt: row.created_at,
  }));
}

export function runTaskArtifacts(db: GatewayDb, runId: RunId): RunTaskArtifact[] {
  const rows = db
    .prepare(
      `SELECT task_id, ordinal, path, label FROM task_artifacts
        WHERE run_id = ? ORDER BY task_id, ordinal LIMIT ${RUN_CHANGES_LIMIT}`,
    )
    .all(runId) as { task_id: string; ordinal: number; path: string; label: string }[];
  return rows.map((row) => ({
    taskId: row.task_id,
    ordinal: row.ordinal,
    path: row.path,
    label: row.label,
  }));
}

/**
 * Learned-memory entries whose source is the run, at their current version. A forgotten entry
 * is listed as tombstoned with its body redacted, as everywhere else (ADR-0011 decision 7).
 */
export function runMemoryWrites(db: GatewayDb, runId: RunId): RunMemoryWrite[] {
  const rows = db
    .prepare(
      `SELECT id, scope, kind, bot_id, thread_id, body, authority, trust, version, tombstoned,
              consolidated_by_run
         FROM memory_entries WHERE source_run_id = ?
        ORDER BY observed_at, id LIMIT ${RUN_CHANGES_LIMIT}`,
    )
    .all(runId) as MemoryWriteRow[];
  return rows.map((row) => ({
    entryId: row.id,
    scope: row.scope,
    kind: row.kind,
    ...(row.bot_id !== null ? { botId: row.bot_id as BotId } : {}),
    ...(row.thread_id !== null ? { threadId: row.thread_id as ThreadId } : {}),
    body: row.tombstoned === 1 ? "" : row.body,
    authority: row.authority,
    trust: row.trust,
    version: row.version,
    tombstoned: row.tombstoned === 1,
    ...(row.consolidated_by_run !== null
      ? { consolidatedByRun: row.consolidated_by_run as RunId }
      : {}),
  }));
}
