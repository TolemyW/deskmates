// Per-workspace memory maintenance settings (ADR-0011 amendment 4, A34): how many notes the model
// may recheck a day (A28) and whether model organisation runs daily (A30). No row means the
// defaults; an Owner or Admin changes them, audited in the same transaction.

import {
  DEFAULT_MEMORY_MAINTENANCE_SETTINGS,
  DeskmatesError,
  MEMORY_RECHECK_DAILY_LIMIT_MAX,
  type MemoryMaintenanceSettings,
  type WorkspaceId,
} from "@deskmates/contracts";
import type { AuditLog } from "../audit/audit-log.js";
import type { GatewayDb } from "../db/open.js";

interface SettingsRow {
  recheck_daily_limit: number;
  organize_daily: number;
}

export function readMaintenanceSettings(
  db: GatewayDb,
  workspaceId: WorkspaceId,
): MemoryMaintenanceSettings {
  const row = db
    .prepare(
      "SELECT recheck_daily_limit, organize_daily FROM memory_maintenance_settings WHERE workspace_id = ?",
    )
    .get(workspaceId) as SettingsRow | undefined;
  return row
    ? { recheckDailyLimit: row.recheck_daily_limit, organizeDaily: row.organize_daily === 1 }
    : { ...DEFAULT_MEMORY_MAINTENANCE_SETTINGS };
}

/** A34: validate a partial change, store it and audit it; an unchanged request writes nothing. */
export function updateMaintenanceSettings(
  db: GatewayDb,
  audit: AuditLog,
  input: { workspaceId: WorkspaceId; patch: Record<string, unknown>; by: string },
): MemoryMaintenanceSettings {
  const { recheckDailyLimit, organizeDaily } = input.patch;
  if (
    recheckDailyLimit !== undefined &&
    (typeof recheckDailyLimit !== "number" ||
      !Number.isInteger(recheckDailyLimit) ||
      recheckDailyLimit < 0 ||
      recheckDailyLimit > MEMORY_RECHECK_DAILY_LIMIT_MAX)
  )
    throw new DeskmatesError(
      "validation",
      `recheckDailyLimit must be an integer from 0 to ${MEMORY_RECHECK_DAILY_LIMIT_MAX}`,
      { field: "recheckDailyLimit" },
    );
  if (organizeDaily !== undefined && typeof organizeDaily !== "boolean")
    throw new DeskmatesError("validation", "organizeDaily must be true or false", {
      field: "organizeDaily",
    });
  return db.transaction(() => {
    const before = readMaintenanceSettings(db, input.workspaceId);
    const after: MemoryMaintenanceSettings = {
      recheckDailyLimit: (recheckDailyLimit as number | undefined) ?? before.recheckDailyLimit,
      organizeDaily: (organizeDaily as boolean | undefined) ?? before.organizeDaily,
    };
    if (
      after.recheckDailyLimit === before.recheckDailyLimit &&
      after.organizeDaily === before.organizeDaily
    )
      return before;
    db.prepare(
      `INSERT INTO memory_maintenance_settings
         (workspace_id, recheck_daily_limit, organize_daily, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET recheck_daily_limit = excluded.recheck_daily_limit,
         organize_daily = excluded.organize_daily, updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    ).run(
      input.workspaceId,
      after.recheckDailyLimit,
      after.organizeDaily ? 1 : 0,
      input.by,
      new Date().toISOString(),
    );
    audit.record({
      action: "memory.maintenance_settings",
      actor: input.by,
      workspaceId: input.workspaceId,
      targetKind: "workspace",
      targetId: input.workspaceId,
      before: { ...before },
      after: { ...after },
    });
    return after;
  })();
}
