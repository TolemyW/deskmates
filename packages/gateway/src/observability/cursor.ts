// The collector's cursor: how far it has read each ledger source, one entry per obs table. It is
// written into the spool with the rows it covers (`spool.ts`), so the received watermark and the
// spooled rows can never disagree after a crash, and into `committed.json` once a batch commits.
//
// Three kinds of source (ADR-0046 decision 2):
// - by autoincrement id (`run_events`, `model_requests`, `run_usage`; `task_runs` by rowid). A row
//   still being filled in (a model request whose usage has not landed) holds the id back; rows
//   past it that are already emitted are kept in `ahead` so they are not emitted twice;
// - by `updated_at` (tasks, threads, Activity summaries; approval decisions by `decided_at`,
//   approval requests by `created_at`, runs by `created_at` plus every open run), as an
//   `(at, id)` keyset;
// - small tables with no change timestamp (bots, workspaces, run marks), scanned whole and
//   compared with the fingerprint of the row last emitted, which also notices a deletion.

import type { ObservabilityTable } from "@deskmates/contracts";

export interface Keyset {
  at: string;
  id: string;
}

export interface IdCursor {
  id: number;
  /** Ids above `id` already emitted while an earlier row was still settling. */
  ahead: number[];
}

/** Ledger row id to the fingerprint of the row last emitted for it. */
export type Seen = Record<string, string>;

export interface CollectorCursor {
  run_events: number;
  model_requests: IdCursor;
  run_usage: IdCursor;
  task_runs: number;
  /** `key` over `created_at`; `open` holds every run last seen in a non-terminal status. */
  run_states: { key: Keyset | null; open: Seen };
  task_states: Keyset | null;
  thread_states: Keyset | null;
  run_summaries: Keyset | null;
  approval_decisions: Keyset | null;
  /** Absent in a cursor written before contract version 2: read from the beginning. */
  approval_requests?: Keyset | null;
  bot_states: Seen;
  workspace_states: Seen;
  run_marks: Seen;
}

export function emptyCursor(): CollectorCursor {
  return {
    run_events: 0,
    model_requests: { id: 0, ahead: [] },
    run_usage: { id: 0, ahead: [] },
    task_runs: 0,
    run_states: { key: null, open: {} },
    task_states: null,
    thread_states: null,
    run_summaries: null,
    approval_decisions: null,
    approval_requests: null,
    bot_states: {},
    workspace_states: {},
    run_marks: {},
  };
}

function idText(cursor: IdCursor): string | null {
  if (cursor.id === 0 && cursor.ahead.length === 0) return null;
  return cursor.ahead.length ? `${cursor.id} +${cursor.ahead.length}` : String(cursor.id);
}

const keyText = (key: Keyset | null): string | null => (key ? `${key.at} ${key.id}` : null);

const seenText = (seen: Seen): string => `${Object.keys(seen).length} tracked`;

/** A table's position for the status route and the batch's source range; null is "nothing". */
export function cursorText(cursor: CollectorCursor, table: ObservabilityTable): string | null {
  switch (table) {
    case "run_events":
      return cursor.run_events === 0 ? null : String(cursor.run_events);
    case "task_runs":
      return cursor.task_runs === 0 ? null : String(cursor.task_runs);
    case "model_requests":
      return idText(cursor.model_requests);
    case "run_usage":
      return idText(cursor.run_usage);
    case "run_states": {
      const key = keyText(cursor.run_states.key);
      return key === null ? null : `${key}, ${Object.keys(cursor.run_states.open).length} open`;
    }
    case "task_states":
    case "thread_states":
    case "run_summaries":
    case "approval_decisions":
    case "approval_requests":
      return keyText(cursor[table] ?? null);
    case "bot_states":
    case "workspace_states":
    case "run_marks":
      return seenText(cursor[table]);
  }
}
