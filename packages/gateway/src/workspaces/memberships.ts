// Workspace memberships (ADR-0031 decision 7, issue #116): a person's role in one workspace.
// Account identity is `users`; this is membership. The protected root account is Owner of every
// workspace by triggers in the schema; a workspace never loses its last active Owner. Every
// change is in the audit record and bumps the membership's authorization version.

import { DeskmatesError, type TenantRole } from "@deskmates/contracts";
import { AuditLog } from "../audit/audit-log.js";
import { nowIso } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";

export const WORKSPACE_ROLES = ["owner", "admin", "member", "guest"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

const RANK: Readonly<Record<WorkspaceRole, number>> = { guest: 0, member: 1, admin: 2, owner: 3 };

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === "string" && (WORKSPACE_ROLES as readonly string[]).includes(value);
}

export function workspaceRoleAtLeast(role: WorkspaceRole, minimum: WorkspaceRole): boolean {
  return RANK[role] >= RANK[minimum];
}

export interface WorkspaceMembership {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  status: "active" | "removed";
  authVersion: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  workspace_id: string;
  user_id: string;
  role: WorkspaceRole;
  status: "active" | "removed";
  auth_version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

function toMembership(row: Row): WorkspaceMembership {
  return {
    workspaceId: row.workspace_id,
    userId: row.user_id,
    role: row.role,
    status: row.status,
    authVersion: row.auth_version,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class WorkspaceMembershipStore {
  constructor(private readonly db: GatewayDb) {}

  get(workspaceId: string, userId: string): WorkspaceMembership | undefined {
    const row = this.db
      .prepare("SELECT * FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?")
      .get(workspaceId, userId) as Row | undefined;
    return row ? toMembership(row) : undefined;
  }

  /** The person's active role in the workspace, or undefined when they are not a member. */
  roleIn(workspaceId: string, userId: string): WorkspaceRole | undefined {
    const membership = this.get(workspaceId, userId);
    return membership?.status === "active" ? membership.role : undefined;
  }

  listForWorkspace(workspaceId: string): WorkspaceMembership[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM workspace_memberships WHERE workspace_id = ? ORDER BY created_at, user_id",
        )
        .all(workspaceId) as Row[]
    ).map(toMembership);
  }

  listForUser(userId: string): WorkspaceMembership[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM workspace_memberships WHERE user_id = ? AND status = 'active' ORDER BY workspace_id",
        )
        .all(userId) as Row[]
    ).map(toMembership);
  }

  /**
   * The highest active role a person holds in any workspace of the tenant, as a tenant-level
   * role for routes that name no workspace; the protected account is always an Owner. None is
   * `undefined`; callers treat it as `guest`: no tenant-level authority (ADR-0031 Q1).
   */
  highestRole(tenantId: string, userId: string): TenantRole | undefined {
    const user = this.db.prepare("SELECT is_protected FROM users WHERE id = ?").get(userId) as
      | { is_protected: number }
      | undefined;
    if (user?.is_protected === 1) return "owner";
    const row = this.db
      .prepare(
        `SELECT max(CASE m.role WHEN 'owner' THEN 3 WHEN 'admin' THEN 2 WHEN 'member' THEN 1 ELSE 0 END) AS rank
           FROM workspace_memberships m JOIN workspaces w ON w.id = m.workspace_id
          WHERE m.user_id = ? AND m.status = 'active' AND w.tenant_id = ?`,
      )
      .get(userId, tenantId) as { rank: number | null };
    const roles = ["guest", "member", "admin", "owner"] as const;
    return row.rank === null ? undefined : roles[row.rank];
  }

  /** Add or reactivate a membership. An existing active membership keeps its role. */
  add(workspaceId: string, userId: string, role: WorkspaceRole, by: string): WorkspaceMembership {
    if (!isWorkspaceRole(role)) throw new DeskmatesError("validation", "unknown workspace role");
    return this.db.transaction(() => {
      const current = this.get(workspaceId, userId);
      if (current?.status === "active") return current;
      const at = nowIso();
      if (current)
        this.db
          .prepare(
            `UPDATE workspace_memberships SET role = ?, status = 'active',
               auth_version = auth_version + 1, updated_at = ? WHERE workspace_id = ? AND user_id = ?`,
          )
          .run(role, at, workspaceId, userId);
      else
        this.db
          .prepare(
            `INSERT INTO workspace_memberships
               (workspace_id, user_id, role, status, created_by, created_at, updated_at)
             VALUES (?, ?, ?, 'active', ?, ?, ?)`,
          )
          .run(workspaceId, userId, role, by, at, at);
      new AuditLog(this.db).record({
        action: "membership.add",
        actor: by,
        workspaceId,
        targetKind: "user",
        targetId: userId,
        after: { role },
      });
      return this.get(workspaceId, userId) as WorkspaceMembership;
    })();
  }

  /**
   * Change a role or remove a membership. The protected account's Owner membership is refused
   * by the schema; any other change that would leave the workspace without an active Owner is
   * refused here, in the same immediate transaction as the write.
   */
  change(
    workspaceId: string,
    userId: string,
    change: { role?: WorkspaceRole; status?: "active" | "removed" },
    by: string,
  ): WorkspaceMembership {
    if (change.role !== undefined && !isWorkspaceRole(change.role))
      throw new DeskmatesError("validation", "unknown workspace role");
    return this.db
      .transaction(() => {
        const current = this.get(workspaceId, userId);
        if (!current) throw new DeskmatesError("not_found", "membership not found");
        const role = change.role ?? current.role;
        const status = change.status ?? current.status;
        if (role === current.role && status === current.status) return current;
        const losesOwner =
          current.role === "owner" &&
          current.status === "active" &&
          (role !== "owner" || status !== "active");
        if (losesOwner) {
          const owners = (
            this.db
              .prepare(
                "SELECT count(*) AS n FROM workspace_memberships WHERE workspace_id = ? AND role = 'owner' AND status = 'active'",
              )
              .get(workspaceId) as { n: number }
          ).n;
          if (owners <= 1)
            throw new DeskmatesError(
              "invalid_transition",
              "the last Owner of a workspace cannot be demoted or removed",
            );
        }
        this.db
          .prepare(
            `UPDATE workspace_memberships SET role = ?, status = ?, auth_version = auth_version + 1,
               updated_at = ? WHERE workspace_id = ? AND user_id = ?`,
          )
          .run(role, status, nowIso(), workspaceId, userId);
        new AuditLog(this.db).record({
          action: status === "removed" ? "membership.remove" : "membership.role",
          actor: by,
          workspaceId,
          targetKind: "user",
          targetId: userId,
          before: { role: current.role, status: current.status },
          after: { role, status },
        });
        return this.get(workspaceId, userId) as WorkspaceMembership;
      })
      .immediate();
  }
}
