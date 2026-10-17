// The workspace approval settings: the approval mode (ADR-0002 amendment 6, D1), `automatic` for a
// new workspace and changed by an Owner or Admin, and the expiry of an unattended request
// (amendment 3, A7; default 60 minutes since amendment 6, D7). Every change is one audit row in
// the same transaction.

import {
  APPROVAL_EXPIRY_DEFAULT_MINUTES,
  APPROVAL_EXPIRY_MAX_MINUTES,
  APPROVAL_EXPIRY_MIN_MINUTES,
  APPROVAL_MODES,
  type ApprovalMode,
  DeskmatesError,
  type WorkspaceAutoApproval,
  type WorkspaceId,
  isApprovalMode,
} from "@deskmates/contracts";
import { AuditLog } from "../audit/audit-log.js";
import type { GatewayDb } from "../db/open.js";

export type AutoApprovalSetting = WorkspaceAutoApproval & { workspaceId: WorkspaceId };

/** What a `PUT` may change; at least one field. */
export interface AutoApprovalChange {
  mode?: ApprovalMode;
  expiryMinutes?: number;
}

interface SettingRow {
  approval_mode: string;
  approval_expiry_minutes: number | null;
}

export class AutoApprovalSettings {
  constructor(private readonly db: GatewayDb) {}

  /** The workspace's approval mode; `manual` for a workspace that does not exist. */
  mode(workspaceId: string): ApprovalMode {
    const value = this.row(workspaceId)?.approval_mode;
    return isApprovalMode(value) ? value : "manual";
  }

  /** Whether the reviewer runs (amendment 4): only in `automatic`. */
  enabled(workspaceId: string): boolean {
    return this.mode(workspaceId) === "automatic";
  }

  get(workspaceId: WorkspaceId): AutoApprovalSetting {
    const row = this.row(workspaceId);
    if (!row) throw new DeskmatesError("not_found", "workspace not found", { workspaceId });
    const mode = isApprovalMode(row.approval_mode) ? row.approval_mode : "manual";
    return {
      workspaceId,
      mode,
      enabled: mode === "automatic",
      expiryMinutes: row.approval_expiry_minutes ?? APPROVAL_EXPIRY_DEFAULT_MINUTES,
    };
  }

  /** Set the mode; setting the current value again changes and records nothing. */
  setMode(workspaceId: WorkspaceId, mode: ApprovalMode, actor: string): AutoApprovalSetting {
    return this.change(workspaceId, { mode }, actor);
  }

  /** Apply each given field; an unchanged field writes nothing and records nothing. */
  change(workspaceId: WorkspaceId, change: AutoApprovalChange, actor: string): AutoApprovalSetting {
    const { expiryMinutes, mode } = change;
    if (mode !== undefined && !isApprovalMode(mode)) {
      throw new DeskmatesError("validation", `mode must be one of ${APPROVAL_MODES.join(", ")}`, {
        field: "mode",
      });
    }
    if (
      expiryMinutes !== undefined &&
      (!Number.isInteger(expiryMinutes) ||
        expiryMinutes < APPROVAL_EXPIRY_MIN_MINUTES ||
        expiryMinutes > APPROVAL_EXPIRY_MAX_MINUTES)
    ) {
      throw new DeskmatesError(
        "validation",
        `expiryMinutes must be a whole number from ${APPROVAL_EXPIRY_MIN_MINUTES} to ${APPROVAL_EXPIRY_MAX_MINUTES}`,
        { field: "expiryMinutes" },
      );
    }
    return this.db.transaction(() => {
      const before = this.get(workspaceId);
      const audit = new AuditLog(this.db);
      if (mode !== undefined && mode !== before.mode) {
        this.db
          .prepare("UPDATE workspaces SET approval_mode = ? WHERE id = ?")
          .run(mode, workspaceId);
        audit.record({
          action: "workspace.approval_mode_set",
          actor,
          workspaceId,
          targetKind: "workspace",
          targetId: workspaceId,
          before: { approvalMode: before.mode },
          after: { approvalMode: mode },
        });
      }
      if (expiryMinutes !== undefined && expiryMinutes !== before.expiryMinutes) {
        this.db
          .prepare("UPDATE workspaces SET approval_expiry_minutes = ? WHERE id = ?")
          .run(expiryMinutes, workspaceId);
        audit.record({
          action: "workspace.approval_expiry_set",
          actor,
          workspaceId,
          targetKind: "workspace",
          targetId: workspaceId,
          before: { approvalExpiryMinutes: before.expiryMinutes },
          after: { approvalExpiryMinutes: expiryMinutes },
        });
      }
      return this.get(workspaceId);
    })();
  }

  private row(workspaceId: string): SettingRow | undefined {
    return this.db
      .prepare("SELECT approval_mode, approval_expiry_minutes FROM workspaces WHERE id = ?")
      .get(workspaceId) as SettingRow | undefined;
  }
}
