// Browser target retention is derived from the append-only ledger. A target belongs to its most
// recent recorded acquirer; this prevents an older completed run from offering a target that a
// newer live run has since reused. The sidecar still validates the target and closes it directly.

import { type RunId, type RunStatus, type WorkspaceId, isTerminal } from "@deskmates/contracts";
import type { GatewayContext } from "../context.js";

const MAX_CLOSE_BATCH = 20;
const DEFAULT_RETAINED_TARGETS = 20;
const DEFAULT_RETENTION_HOURS = 24;

interface AcquisitionRow {
  run_id: string;
  status: RunStatus;
  tab_id: string;
  acquired_at: string;
  finished_at: string | null;
}

interface Candidate {
  targetId: string;
  completedAtMs: number;
  acquiredAtMs: number;
}

export interface IssuedRetentionPlan {
  workspaceId: string;
  targetIds: string[];
}

function configuredRetainedCount(ctx: GatewayContext): number {
  const configured = ctx.config.browserRetainedTabs ?? DEFAULT_RETAINED_TARGETS;
  return Math.max(0, Math.floor(configured));
}

function configuredRetentionMs(ctx: GatewayContext): number {
  const hours = ctx.config.browserTabRetentionHours ?? DEFAULT_RETENTION_HOURS;
  return Math.max(0, hours) * 60 * 60 * 1000;
}

/** Targets previously confirmed closed in this workspace must never be offered again. */
export function closedRetentionTargets(ctx: GatewayContext, workspaceId: WorkspaceId): Set<string> {
  const rows = ctx.db
    .prepare(
      `SELECT targets.value AS target_id
       FROM run_events e
       JOIN runs r ON r.id = e.run_id
       JOIN bots b ON b.id = r.bot_id
       JOIN json_each(e.payload_json, '$.targetIds') AS targets
       WHERE b.workspace_id = ?
         AND e.kind = 'log'
         AND e.source = 'browser_retention'
         AND json_extract(e.payload_json, '$.phase') = 'closed'
         AND json_type(e.payload_json, '$.targetIds') = 'array'
         AND targets.type = 'text'`,
    )
    .all(workspaceId) as Array<{ target_id: string }>;
  return new Set(rows.map((row) => row.target_id));
}

/** Last cleanup plan issued to a run, used to authorize its later close acknowledgement. */
export function latestIssuedRetentionPlan(
  ctx: GatewayContext,
  runId: RunId,
): IssuedRetentionPlan | undefined {
  const row = ctx.db
    .prepare(
      `SELECT payload_json
       FROM run_events
       WHERE run_id = ?
         AND kind = 'log'
         AND source = 'browser_retention'
         AND json_extract(payload_json, '$.phase') = 'planned'
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get(runId) as { payload_json: string } | undefined;
  if (!row) return undefined;
  try {
    const payload = JSON.parse(row.payload_json) as Partial<IssuedRetentionPlan>;
    if (
      typeof payload.workspaceId !== "string" ||
      !Array.isArray(payload.targetIds) ||
      payload.targetIds.some((targetId) => typeof targetId !== "string")
    )
      return undefined;
    return { workspaceId: payload.workspaceId, targetIds: payload.targetIds as string[] };
  } catch {
    return undefined;
  }
}

/**
 * Returns stable browser target ids that the current run may close after opening its own tab.
 * The newest configured number stay open while they are fresh. Overflow and expired targets are
 * returned oldest-first in a cleanup batch capped at twenty targets.
 */
export function retentionCandidates(
  ctx: GatewayContext,
  runId: RunId,
  now: Date = new Date(),
): string[] {
  const currentRun = ctx.runs.mustGet(runId);
  const workspaceId = ctx.bots.mustGet(currentRun.botId).workspaceId;
  const rows = ctx.db
    .prepare(
      `SELECT
         r.id AS run_id,
         r.status,
         json_extract(e.payload_json, '$.tabId') AS tab_id,
         e.ts AS acquired_at,
         r.finished_at
       FROM run_events e
       JOIN runs r ON r.id = e.run_id
       JOIN bots b ON b.id = r.bot_id
       WHERE b.workspace_id = ?
         AND e.kind = 'log'
         AND e.source = 'browser_lock'
         AND json_extract(e.payload_json, '$.op') = 'tab_acquired'
         AND json_type(e.payload_json, '$.tabId') = 'text'
         AND length(json_extract(e.payload_json, '$.tabId')) > 0
       ORDER BY e.ts DESC, e.id DESC`,
    )
    .all(workspaceId) as AcquisitionRow[];

  const heldTargets = new Set(
    ctx.locks
      .list(workspaceId)
      .map((lock) => lock.tabId)
      .filter((targetId): targetId is string => targetId !== undefined),
  );
  const closedTargets = closedRetentionTargets(ctx, workspaceId);
  const cutoffMs = now.getTime() - configuredRetentionMs(ctx);
  const seenTargets = new Set<string>();
  const candidates: Candidate[] = [];

  for (const row of rows) {
    // Mark before filtering: only the latest acquirer can establish a target as closeable.
    if (seenTargets.has(row.tab_id)) continue;
    seenTargets.add(row.tab_id);

    if (
      row.run_id === runId ||
      !isTerminal(row.status) ||
      heldTargets.has(row.tab_id) ||
      closedTargets.has(row.tab_id)
    )
      continue;
    const acquiredAtMs = Date.parse(row.acquired_at);
    const completedAtMs = Date.parse(row.finished_at ?? row.acquired_at);
    if (!Number.isFinite(acquiredAtMs) || !Number.isFinite(completedAtMs)) continue;
    candidates.push({ targetId: row.tab_id, completedAtMs, acquiredAtMs });
  }

  candidates.sort(
    (left, right) =>
      right.completedAtMs - left.completedAtMs ||
      right.acquiredAtMs - left.acquiredAtMs ||
      left.targetId.localeCompare(right.targetId),
  );
  const retainedCount = configuredRetainedCount(ctx);
  return candidates
    .filter((candidate, index) => index >= retainedCount || candidate.completedAtMs <= cutoffMs)
    .sort(
      (left, right) =>
        left.completedAtMs - right.completedAtMs ||
        left.acquiredAtMs - right.acquiredAtMs ||
        left.targetId.localeCompare(right.targetId),
    )
    .slice(0, MAX_CLOSE_BATCH)
    .map((candidate) => candidate.targetId);
}
