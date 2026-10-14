// The workspace automatic-approval setting (ADR-0002 amendment 4, B1). Off for every workspace
// until an Owner or Admin turns it on; every change is one audit row in the same transaction.

import { DeskmatesError, type WorkspaceId } from "@deskmates/contracts";
import { AuditLog } from "../audit/audit-log.js";
import type { GatewayDb } from "../db/open.js";

export interface AutoApprovalSetting {
  workspaceId: WorkspaceId;
  enabled: boolean;
}

export class AutoApprovalSettings {
  constructor(private readonly db: GatewayDb) {}

  enabled(workspaceId: string): boolean {
    const row = this.db
      .prepare("SELECT auto_approval FROM workspaces WHERE id = ?")
      .get(workspaceId) as { auto_approval: number } | undefined;
    return row?.auto_approval === 1;
  }

  get(workspaceId: WorkspaceId): AutoApprovalSetting {
    const row = this.db
      .prepare("SELECT auto_approval FROM workspaces WHERE id = ?")
      .get(workspaceId) as { auto_approval: number } | undefined;
    if (!row) throw new DeskmatesError("not_found", "workspace not found", { workspaceId });
    return { workspaceId, enabled: row.auto_approval === 1 };
  }

  /** Set the value; setting the current value again changes and records nothing. */
  set(workspaceId: WorkspaceId, enabled: boolean, actor: string): AutoApprovalSetting {
    return this.db.transaction(() => {
      const before = this.get(workspaceId);
      if (before.enabled === enabled) return before;
      this.db
        .prepare("UPDATE workspaces SET auto_approval = ? WHERE id = ?")
        .run(enabled ? 1 : 0, workspaceId);
      new AuditLog(this.db).record({
        action: "workspace.auto_approval_set",
        actor,
        workspaceId,
        targetKind: "workspace",
        targetId: workspaceId,
        before: { autoApproval: before.enabled },
        after: { autoApproval: enabled },
      });
      return { workspaceId, enabled };
    })();
  }
}
