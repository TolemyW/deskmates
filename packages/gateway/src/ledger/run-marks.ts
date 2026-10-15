// An operator's "this run was wrong" mark (issue #11, ADR-0042 decision 3). One row per run in
// `run_marks`; the row is the run's do-not-learn flag. While it stands, consolidation does not
// take the run's experience candidates (`memory/entries.ts` `consolidationInput`, the eligibility
// counter in `memory/consolidation.ts`), and a run marked before it ends records its learned
// items as skipped (`scheduler/run-lifecycle.ts`). Unmarking deletes the row, which restores both.
// Entries the run already applied are left alone: curating those stays a human edit.

import {
  DeskmatesError,
  RUN_MARK_NOTE_MAX,
  type RunId,
  type RunMark,
  type RunMarkVerdict,
} from "@deskmates/contracts";
import { nowIso } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";

interface RunMarkRow {
  run_id: string;
  verdict: RunMarkVerdict;
  note: string | null;
  marked_by: string;
  marked_at: string;
}

/** The skip reason a marked run's learned items are recorded with. */
export const MARKED_WRONG_REASON = "marked_wrong";

/**
 * SQL condition: the run whose id is in `column` carries no "wrong" mark. Consolidation's source
 * queries add it so a marked run's candidates are neither counted nor consumed.
 */
export function notMarkedWrong(column: string): string {
  return `NOT EXISTS (SELECT 1 FROM run_marks m WHERE m.run_id = ${column} AND m.verdict = 'wrong')`;
}

function toMark(row: RunMarkRow): RunMark {
  return {
    runId: row.run_id as RunId,
    verdict: row.verdict,
    ...(row.note !== null ? { note: row.note } : {}),
    markedBy: row.marked_by,
    markedAt: row.marked_at,
  };
}

export class RunMarkStore {
  constructor(private readonly db: GatewayDb) {}

  get(runId: RunId): RunMark | undefined {
    const row = this.db.prepare("SELECT * FROM run_marks WHERE run_id = ?").get(runId) as
      | RunMarkRow
      | undefined;
    return row ? toMark(row) : undefined;
  }

  /** The marks of these runs, by run id; runs without one are absent. */
  forRuns(runIds: readonly RunId[]): Map<RunId, RunMark> {
    const marks = new Map<RunId, RunMark>();
    if (runIds.length === 0) return marks;
    const rows = this.db
      .prepare("SELECT * FROM run_marks WHERE run_id IN (SELECT value FROM json_each(?))")
      .all(JSON.stringify(runIds)) as RunMarkRow[];
    for (const row of rows) marks.set(row.run_id as RunId, toMark(row));
    return marks;
  }

  /** Whether the run is do-not-learn because an operator marked it wrong. */
  isWrong(runId: RunId): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM run_marks WHERE run_id = ? AND verdict = 'wrong'")
        .get(runId) !== undefined
    );
  }

  /** Mark the run wrong, or replace the note of an existing mark. */
  mark(runId: RunId, input: { note?: string; markedBy: string }): RunMark {
    const note = input.note?.trim() || null;
    if (note !== null && note.length > RUN_MARK_NOTE_MAX)
      throw new DeskmatesError(
        "validation",
        `note is longer than ${RUN_MARK_NOTE_MAX} characters`,
        {
          field: "note",
        },
      );
    const run = this.db.prepare("SELECT workspace_id FROM runs WHERE id = ?").get(runId) as
      | { workspace_id: string }
      | undefined;
    if (!run) throw new DeskmatesError("not_found", `run ${runId} not found`, { runId });
    const row: RunMarkRow = {
      run_id: runId,
      verdict: "wrong",
      note,
      marked_by: input.markedBy,
      marked_at: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO run_marks (run_id, workspace_id, verdict, note, marked_by, marked_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (run_id) DO UPDATE SET verdict = excluded.verdict, note = excluded.note,
           marked_by = excluded.marked_by, marked_at = excluded.marked_at`,
      )
      .run(runId, run.workspace_id, row.verdict, row.note, row.marked_by, row.marked_at);
    return toMark(row);
  }

  /** Remove the mark; returns whether there was one. */
  unmark(runId: RunId): boolean {
    return this.db.prepare("DELETE FROM run_marks WHERE run_id = ?").run(runId).changes > 0;
  }
}
