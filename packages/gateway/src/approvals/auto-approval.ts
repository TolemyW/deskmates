// The workspace approval settings: automatic approval (ADR-0002 amendment 4, B1), off for every
// workspace until an Owner or Admin turns it on, and the expiry of an unattended request
// (amendment 3, A7). Every change is one audit row in the same transaction.

import {
  APPROVAL_EXPIRY_DEFAULT_MINUTES,
  APPROVAL_EXPIRY_MAX_MINUTES,
  APPROVAL_EXPIRY_MIN_MINUTES,
  DeskmatesError,
  type WorkspaceAutoApproval,
  type WorkspaceId,
} from "@deskmates/contracts";
import { AuditLog } from "../audit/audit-log.js";
import type { GatewayDb } from "../db/open.js";

export type AutoApprovalSetting = WorkspaceAutoApproval & { workspaceId: WorkspaceId };

/** What a `PUT` may change; at least one field. */
export interface AutoApprovalChange {
  enabled?: boolean;
  expiryMinutes?: number;
}

interface SettingRow {
  auto_approval: number;
  approval_expiry_minutes: number | null;
}

export class AutoApprovalSettings {
  constructor(private readonly db: GatewayDb) {}

  enabled(workspaceId: string): boolean {
    return this.row(workspaceId)?.auto_approval === 1;
  }

  get(workspaceId: WorkspaceId): AutoApprovalSetting {
    const row = this.row(workspaceId);
    if (!row) throw new DeskmatesError("not_found", "workspace not found", { workspaceId });
    return {
      workspaceId,
      enabled: row.auto_approval === 1,
      expiryMinutes: row.approval_expiry_minutes ?? APPROVAL_EXPIRY_DEFAULT_MINUTES,
    };
  }

  /** Set the value; setting the current value again changes and records nothing. */
  set(workspaceId: WorkspaceId, enabled: boolean, actor: string): AutoApprovalSetting {
    return this.change(workspaceId, { enabled }, actor);
  }

  /** Apply each given field; an unchanged field writes nothing and records nothing. */
  change(workspaceId: WorkspaceId, change: AutoApprovalChange, actor: string): AutoApprovalSetting {
    const { expiryMinutes } = change;
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
      if (change.enabled !== undefined && change.enabled !== before.enabled) {
        this.db
          .prepare("UPDATE workspaces SET auto_approval = ? WHERE id = ?")
          .run(change.enabled ? 1 : 0, workspaceId);
        audit.record({
          action: "workspace.auto_approval_set",
          actor,
          workspaceId,
          targetKind: "workspace",
          targetId: workspaceId,
          before: { autoApproval: before.enabled },
          after: { autoApproval: change.enabled },
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
      .prepare("SELECT auto_approval, approval_expiry_minutes FROM workspaces WHERE id = ?")
      .get(workspaceId) as SettingRow | undefined;
  }
}
