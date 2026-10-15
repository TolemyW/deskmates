// Reads what the startup-latency report needs out of a Gateway SQLite file (ADR-0037 decision 6):
// runs, the triggering messages' times and the ledger events a timeline is derived from. Read-only
// by construction: every statement is a SELECT and the CLI opens the file with `readonly: true`.

import type { RunTimelineEvent, RunTimelineInput } from "@deskmates/contracts";

/** The slice of better-sqlite3's `Database` this needs; the gateway's own handle satisfies it. */
export interface ReadableDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

export interface LatencyRun extends RunTimelineInput {
  /** `runs.config_json.runType`: summary and model jobs are reported apart from agent runs. */
  runType: string | null;
  triggerKind: string;
}

interface RunRow {
  id: string;
  status: string;
  attempt: number;
  trigger_kind: string;
  trigger_ref: string;
  run_type: string | null;
  created_at: string;
  finished_at: string | null;
  submitted_at: string | null;
}

interface EventRow {
  run_id: string;
  attempt: number;
  kind: string;
  payload_json: string;
  ts: string;
}

export function loadLatencyRuns(db: ReadableDb, since?: string): LatencyRun[] {
  const runs = db
    .prepare(
      `SELECT r.id, r.status, r.attempt, r.trigger_kind, r.trigger_ref, r.run_type,
              r.created_at, r.finished_at,
              CASE WHEN r.trigger_kind = 'thread_message'
                   THEN (SELECT m.ts FROM thread_messages m WHERE m.id = r.trigger_ref) END
                AS submitted_at
         FROM runs r
        WHERE (? IS NULL OR r.created_at >= ?)
        ORDER BY r.created_at, r.id`,
    )
    .all(since ?? null, since ?? null) as RunRow[];
  const events = db
    .prepare(
      `SELECT e.run_id, e.attempt, e.kind, e.payload_json, e.ts
         FROM run_events e JOIN runs r ON r.id = e.run_id
        WHERE (? IS NULL OR r.created_at >= ?)
          AND (e.kind IN ('model_retry', 'turn_usage')
               OR (e.kind = 'log' AND (e.source IN ('run_timeline', 'phase_timing')
                                       OR json_extract(e.payload_json, '$.tool') = 'thread_post')))
        ORDER BY e.run_id, e.seq`,
    )
    .all(since ?? null, since ?? null) as EventRow[];
  const byRun = new Map<string, RunTimelineEvent[]>();
  for (const row of events) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    } catch {
      continue;
    }
    const list = byRun.get(row.run_id) ?? [];
    list.push({ kind: row.kind, attempt: row.attempt, payload, ts: row.ts });
    byRun.set(row.run_id, list);
  }
  return runs.map((row) => ({
    runId: row.id,
    status: row.status,
    attempt: row.attempt,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    submittedAt: row.submitted_at,
    runType: row.run_type,
    triggerKind: row.trigger_kind,
    events: byRun.get(row.id) ?? [],
  }));
}
