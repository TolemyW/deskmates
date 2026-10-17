// The periodic pass of memory maintenance (ADR-0011 amendment 4, owner ruling 2026-10-14): after
// the freshness sweep (A26), queue at most one recheck job (A28) and one daily organisation job
// (A30) per workspace. Each step is bounded and idempotent; a failure is logged, never thrown into
// the scheduler's pass.

import type { WorkspaceId } from "@deskmates/contracts";
import type { GatewayContext } from "../context.js";
import type { RunRecord } from "../ledger/runs.js";

/** Workspaces one pass considers for each kind, so a large deployment never stalls the pass. */
const WORKSPACES_PER_PASS = 20;

/** The scheduler kicks often; maintenance looks at most this often per Gateway process. */
export const MAINTENANCE_PASS_INTERVAL_MS = 60_000;
const lastPass = new WeakMap<GatewayContext, number>();

/** The runs this pass created, for the caller to publish. */
export function queueMemoryMaintenance(
  ctx: GatewayContext,
  now: Date = new Date(),
  log: (message: string) => void = () => {},
): RunRecord[] {
  const runs: RunRecord[] = [];
  const previous = lastPass.get(ctx);
  if (previous !== undefined && Math.abs(now.getTime() - previous) < MAINTENANCE_PASS_INTERVAL_MS)
    return runs;
  lastPass.set(ctx, now.getTime());
  ctx.memory.freshness.sweepDue(now, log);
  const each = (
    sql: string,
    params: unknown[],
    step: (id: WorkspaceId) => RunRecord | undefined,
  ): void => {
    let ids: { id: WorkspaceId }[] = [];
    try {
      ids = ctx.db.prepare(sql).all(...params, WORKSPACES_PER_PASS) as { id: WorkspaceId }[];
    } catch (error) {
      log(`memory maintenance query failed: ${String(error)}`);
    }
    for (const { id } of ids) {
      try {
        const run = step(id);
        if (run) runs.push(run);
      } catch (error) {
        log(`memory maintenance for ${id} failed: ${String(error)}`);
      }
    }
  };
  // A28: workspaces with open flags a model may answer and no pending recheck job. Random order,
  // so workspaces whose daily limit is spent do not starve the others.
  each(
    `SELECT id FROM (SELECT DISTINCT r.workspace_id AS id FROM memory_revalidations r
      WHERE r.status = 'open' AND r.reason <> 'replaced_trusted'
        AND NOT EXISTS (SELECT 1 FROM memory_recheck_jobs j
                         WHERE j.workspace_id = r.workspace_id AND j.status = 'pending'))
      ORDER BY random() LIMIT ?`,
    [],
    (id) => ctx.modelJobs.recheck.request(id, now)?.run,
  );
  // A30: workspaces with a current note without a model label and no organisation job today.
  each(
    `SELECT id FROM (SELECT DISTINCT e.workspace_id AS id FROM memory_entries e
      WHERE e.kind = 'note' AND e.scope IN ('workspace', 'bot') AND e.tombstoned = 0
        AND e.invalid_at IS NULL AND e.topic_source <> 'model'
        AND NOT EXISTS (SELECT 1 FROM memory_organize_jobs j
                         WHERE j.workspace_id = e.workspace_id
                           AND (j.status = 'pending' OR j.created_at > ?)))
      ORDER BY random() LIMIT ?`,
    [new Date(now.getTime() - 86_400_000).toISOString()],
    (id) => ctx.modelJobs.organize.requestDaily(id, now)?.run,
  );
  return runs;
}
