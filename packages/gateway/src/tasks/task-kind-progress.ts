// Criteria progress of a templated task (ADR-0021 amendment 4, A4e), read from the task's own
// checkpoints and deliveries in Gateway time order. A criterion is named by its label at the
// start of a checkpoint unit or an outstanding item; the last mention decides. Nothing is
// inferred from a complete delivery, and a discrepancy is named, never corrected.

import type {
  IsoTimestamp,
  TaskCheckpointUnit,
  TaskCriterionProgress,
  TaskKindDiscrepancy,
  TaskKindProgress,
  TaskKindStamp,
  TaskStatus,
} from "@deskmates/contracts";
import { parseJson } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";

/** One report against the criteria: a checkpoint or a delivery, at its Gateway time. */
export interface ProgressReport {
  source: "checkpoint" | "delivery";
  createdAt: IsoTimestamp;
  completed: TaskCheckpointUnit[];
  outstanding: string[];
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `text` starts with `label` (an optional `[` first), not with a longer label. */
export function namesLabel(text: string, label: string): boolean {
  return new RegExp(`^\\s*\\[?${escapeRegExp(label.toLowerCase())}(?![0-9a-z-])`).test(
    text.toLowerCase(),
  );
}

export function kindProgress(
  stamp: Pick<TaskKindStamp, "stages">,
  status: TaskStatus,
  reports: readonly ProgressReport[],
): TaskKindProgress {
  const ordered = [...reports].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const criteria: TaskCriterionProgress[] = stamp.stages.flatMap((stage) =>
    stage.criteria.map((c) => ({
      label: c.label,
      stageKey: stage.key,
      text: c.text,
      state: "unreported" as const,
      evidence: 0,
      reportedAt: null,
    })),
  );
  const checkpointed = new Set<string>();
  for (const report of ordered) {
    for (const criterion of criteria) {
      const unit = report.completed.find((u) => namesLabel(u.unit, criterion.label));
      if (unit) {
        criterion.state = "met";
        criterion.evidence = unit.evidence.length;
        criterion.reportedAt = report.createdAt;
      }
      if (report.outstanding.some((item) => namesLabel(item, criterion.label))) {
        criterion.state = "open";
        criterion.evidence = 0;
        criterion.reportedAt = report.createdAt;
      }
    }
    if (report.source !== "checkpoint") continue;
    for (const stage of stamp.stages)
      if (
        report.completed.some(
          (u) =>
            namesLabel(u.unit, stage.key) ||
            stage.criteria.some((c) => namesLabel(u.unit, c.label)),
        )
      )
        checkpointed.add(stage.key);
  }
  const currentStage =
    stamp.stages.find((stage) =>
      criteria.some((c) => c.stageKey === stage.key && c.state !== "met"),
    )?.key ?? null;
  const missingCheckpoints = stamp.stages
    .filter((s) => s.checkpointRequired && !checkpointed.has(s.key))
    .map((s) => s.key);
  const discrepancies: TaskKindDiscrepancy[] = [];
  if (status === "delivered" || status === "accepted") {
    if (missingCheckpoints.length > 0)
      discrepancies.push({ kind: "delivered_missing_checkpoint", items: missingCheckpoints });
    const open = criteria.filter((c) => c.state === "open").map((c) => c.label);
    if (open.length > 0) discrepancies.push({ kind: "delivered_open_criteria", items: open });
  }
  return { criteria, currentStage, missingCheckpoints, discrepancies };
}

/** A task's checkpoints and deliveries, as reports for `kindProgress`. */
export function progressReports(db: GatewayDb, taskId: string): ProgressReport[] {
  const checkpoints = (
    db
      .prepare(`SELECT c.body_json, c.created_at FROM task_checkpoints c
        JOIN tasks t ON t.id = c.task_id
        WHERE c.task_id = ? AND json_extract(c.body_json, '$.scopeVersion') = t.scope_version
        ORDER BY c.created_at, c.rowid`)
      .all(taskId) as { body_json: string; created_at: string }[]
  ).map((row): ProgressReport => {
    const body = parseJson<{ completed?: TaskCheckpointUnit[]; outstanding?: string[] }>(
      row.body_json,
      {},
    );
    return {
      source: "checkpoint",
      createdAt: row.created_at,
      completed: body.completed ?? [],
      outstanding: body.outstanding ?? [],
    };
  });
  const deliveries = (
    db
      .prepare(`SELECT d.outstanding_json, d.created_at FROM task_deliveries d
        JOIN tasks t ON t.id = d.task_id
        WHERE d.task_id = ? AND d.scope_version = t.scope_version
        ORDER BY d.created_at, d.rowid`)
      .all(taskId) as { outstanding_json: string; created_at: string }[]
  ).map(
    (row): ProgressReport => ({
      source: "delivery",
      createdAt: row.created_at,
      completed: [],
      outstanding: parseJson<string[]>(row.outstanding_json, []),
    }),
  );
  return [...checkpoints, ...deliveries];
}
