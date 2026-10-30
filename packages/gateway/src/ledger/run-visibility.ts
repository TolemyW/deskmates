// Run visibility (issue #70): what a run did that someone else can see, reported beside its
// status by the run API. The flags are derived on read from the run's status, thread, final
// reply and the events the Gateway appended when it accepted a post, an approval decision or a
// task delivery, so no stored row is relabelled and runs recorded before this module get the
// same flags as new ones. That includes `silent` by the owner's definition of 2026-10-17 (a
// thread run that ended successfully without posting a message; ADR-0005, "Definition of
// `silent`"): an older run stored `silent` that posted through `thread_post` is not silent here.
// The definition itself is `deriveRunVisibility` in contracts; this module only fetches inputs.

import {
  type Run,
  type RunId,
  type RunVisibility,
  type RunVisibilityEvent,
  deriveRunVisibility,
} from "@deskmates/contracts";
import { parseJson } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";

/**
 * The candidate events for a set of runs, narrowed in SQL to the record shapes the derivation
 * reads; `deriveRunVisibility` still checks each one. `run_events(run_id, seq)` is unique, so the
 * lookup is indexed per run.
 */
export const RUN_VISIBILITY_EVENTS_SQL = `SELECT run_id, kind, payload_json FROM run_events
  WHERE run_id IN (SELECT value FROM json_each(?))
    AND ((kind = 'log'
          AND json_extract(payload_json, '$.tool') IN ('thread_post', 'message_bot', 'task_deliver'))
      OR (kind = 'approval' AND json_extract(payload_json, '$.phase') = 'decided_by_tool'))`;

/** The run fields the derivation reads. */
export type VisibilityRun = Pick<Run, "id" | "summary" | "status" | "threadId">;

interface VisibilityRow {
  run_id: string;
  kind: string;
  payload_json: string;
}

/** Visibility for each given run, keyed by run id. One query, whatever the number of runs. */
export function runVisibility(
  db: GatewayDb,
  runs: readonly VisibilityRun[],
): Map<RunId, RunVisibility> {
  const out = new Map<RunId, RunVisibility>();
  if (runs.length === 0) return out;
  const events = new Map<string, RunVisibilityEvent[]>();
  const rows = db
    .prepare(RUN_VISIBILITY_EVENTS_SQL)
    .all(JSON.stringify(runs.map((r) => r.id))) as VisibilityRow[];
  for (const row of rows) {
    const list = events.get(row.run_id) ?? [];
    list.push({
      kind: row.kind,
      payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
    });
    events.set(row.run_id, list);
  }
  for (const run of runs) {
    out.set(
      run.id,
      deriveRunVisibility({
        ...(run.summary ? { reply: run.summary.reply } : {}),
        events: events.get(run.id) ?? [],
        status: run.status,
        ...(run.threadId === undefined ? {} : { threadId: run.threadId }),
      }),
    );
  }
  return out;
}

/** The run with its visibility attached, as the run API returns it. */
export function withVisibility<R extends VisibilityRun>(
  db: GatewayDb,
  runs: readonly R[],
): (R & { visibility: RunVisibility })[] {
  const map = runVisibility(db, runs);
  return runs.map((run) => ({ ...run, visibility: map.get(run.id) as RunVisibility }));
}
