// Run visibility (issue #70): what a run did that someone else can see, reported beside its
// status by the run API. `silent` keeps its ADR-0005 decision 3 meaning; these flags are derived
// on read from the run's final reply and the events the Gateway appended when it accepted a
// post, an approval decision or a task delivery, so no stored row is relabelled and runs
// recorded before this module get the same flags as new ones. The definition itself is
// `deriveRunVisibility` in contracts; this module only fetches its inputs.

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

interface VisibilityRow {
  run_id: string;
  kind: string;
  payload_json: string;
}

/** Visibility for each given run, keyed by run id. One query, whatever the number of runs. */
export function runVisibility(
  db: GatewayDb,
  runs: readonly Pick<Run, "id" | "summary">[],
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
      }),
    );
  }
  return out;
}

/** The run with its visibility attached, as the run API returns it. */
export function withVisibility<R extends Pick<Run, "id" | "summary">>(
  db: GatewayDb,
  runs: readonly R[],
): (R & { visibility: RunVisibility })[] {
  const map = runVisibility(db, runs);
  return runs.map((run) => ({ ...run, visibility: map.get(run.id) as RunVisibility }));
}
