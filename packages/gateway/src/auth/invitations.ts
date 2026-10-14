// Tenant invitations (ADR-0022 P4, test plan INV-01; amendment 4). An invitation binds a tenant,
// a fixed role (Admin, Member or Guest) and, except for an open sign-up link (`local_signup`), one exact
// identity. It is consumed once by an atomic update. The acceptance request supplies only the
// token and, for a new local account, a password, a display name and (for `local_signup`) the
// chosen username: never the tenant or the role.

import { DeskmatesError, type TenantRole } from "@deskmates/contracts";
import { AuditLog } from "../audit/audit-log.js";
import { newId } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";
import { hashToken, newOpaqueToken } from "./tokens.js";
import { normalizeLoginName } from "./user-store.js";

export const INVITATION_TTL_SECONDS_DEFAULT = 7 * 24 * 60 * 60;
export const INVITATION_TTL_SECONDS_MAX = 30 * 24 * 60 * 60;

export type InvitationRole = Extract<TenantRole, "admin" | "member" | "guest">;

export type InvitationTarget =
  | { kind: "local_signup" }
  | { kind: "local_new"; loginName: string }
  | { kind: "local_user"; loginName: string }
  | { kind: "oidc_email"; providerId: string; email: string };

export interface Invitation {
  id: string;
  tenantId: string;
  /** The workspace the invitee joins with `role` (ADR-0031 decision 7). */
  workspaceId: string;
  role: InvitationRole;
  targetKind: InvitationTarget["kind"];
  /** Login name, or the email the IdP must assert as verified; null for `local_signup`. */
  targetValue: string | null;
  providerId: string | null;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
  consumedByUserId: string | null;
  revokedAt: string | null;
}

interface InvitationRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  role: InvitationRole;
  target_kind: InvitationTarget["kind"];
  target_value: string | null;
  provider_id: string | null;
  created_by: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  consumed_by_user_id: string | null;
  revoked_at: string | null;
}

function toInvitation(row: InvitationRow): Invitation {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    role: row.role,
    targetKind: row.target_kind,
    targetValue: row.target_value,
    providerId: row.provider_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    consumedByUserId: row.consumed_by_user_id,
    revokedAt: row.revoked_at,
  };
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

/** Emails compare case-insensitively; nothing else about them is trusted. */
export function normalizeEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (!EMAIL.test(email)) throw new DeskmatesError("validation", "email is not an email address");
  return email;
}

export class InvitationStore {
  constructor(
    private readonly db: GatewayDb,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Create an invitation; the token is returned once and only its hash is stored. */
  create(
    tenantId: string,
    input: {
      workspaceId: string;
      role: InvitationRole;
      target: InvitationTarget;
      createdBy: string;
      ttlSeconds?: number;
    },
  ): { invitation: Invitation; token: string } {
    if (input.role !== "admin" && input.role !== "member" && input.role !== "guest")
      throw new DeskmatesError("validation", "an invitation's role must be admin, member or guest");
    if (
      !this.db
        .prepare("SELECT 1 FROM workspaces WHERE id = ? AND tenant_id = ? AND archived_at IS NULL")
        .get(input.workspaceId, tenantId)
    )
      throw new DeskmatesError("not_found", "workspace not found", {
        workspaceId: input.workspaceId,
      });
    const ttl = input.ttlSeconds ?? INVITATION_TTL_SECONDS_DEFAULT;
    if (!Number.isInteger(ttl) || ttl <= 0 || ttl > INVITATION_TTL_SECONDS_MAX)
      throw new DeskmatesError("validation", "expiry must be between 1 second and 30 days");
    const target = input.target;
    let value: string | null;
    let providerId: string | null = null;
    switch (target.kind) {
      case "local_signup":
        value = null;
        break;
      case "local_new":
      case "local_user":
        value = normalizeLoginName(target.loginName);
        break;
      case "oidc_email":
        value = normalizeEmail(target.email);
        providerId = target.providerId;
        break;
      default:
        throw new DeskmatesError(
          "validation",
          "target kind must be local_signup, local_new, local_user or oidc_email",
        );
    }
    const now = this.clock();
    const token = newOpaqueToken();
    const id = newId("inv");
    const insert = this.db.prepare(
      `INSERT INTO invitations (id, tenant_id, workspace_id, token_hash, role, target_kind,
         target_value, provider_id, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      insert.run(
        id,
        tenantId,
        input.workspaceId,
        hashToken(token),
        input.role,
        target.kind,
        value,
        providerId,
        input.createdBy,
        now.toISOString(),
        new Date(now.getTime() + ttl * 1000).toISOString(),
      );
      new AuditLog(this.db).record({
        action: "invitation.create",
        actor: input.createdBy,
        workspaceId: input.workspaceId,
        targetKind: "invitation",
        targetId: id,
        after: { role: input.role, targetKind: target.kind, ttlSeconds: ttl },
      });
    })();
    return { invitation: this.get(tenantId, id) as Invitation, token };
  }

  get(tenantId: string, id: string): Invitation | undefined {
    const row = this.db
      .prepare("SELECT * FROM invitations WHERE id = ? AND tenant_id = ?")
      .get(id, tenantId) as InvitationRow | undefined;
    return row ? toInvitation(row) : undefined;
  }

  list(tenantId: string): Invitation[] {
    return (
      this.db
        .prepare("SELECT * FROM invitations WHERE tenant_id = ? ORDER BY created_at DESC, id")
        .all(tenantId) as InvitationRow[]
    ).map(toInvitation);
  }

  /**
   * One offset page of a workspace's invitations, newest first then by id, with the total
   * (#113 slice M). Reads through `invitations_workspace (workspace_id, created_at, id)`.
   */
  pageForWorkspace(
    tenantId: string,
    workspaceId: string,
    page: { offset: number; limit: number },
  ): { invitations: Invitation[]; total: number } {
    const { total } = this.db
      .prepare("SELECT count(*) AS total FROM invitations WHERE workspace_id = ? AND tenant_id = ?")
      .get(workspaceId, tenantId) as { total: number };
    const rows = this.db
      .prepare(
        `SELECT * FROM invitations WHERE workspace_id = ? AND tenant_id = ?
         ORDER BY created_at DESC, id LIMIT ? OFFSET ?`,
      )
      .all(workspaceId, tenantId, page.limit, page.offset) as InvitationRow[];
    return { invitations: rows.map(toInvitation), total };
  }

  /** Revoke an open invitation of this tenant; another tenant's id is simply not found. */
  revoke(tenantId: string, id: string, actor = "operator"): boolean {
    return this.db.transaction(() => {
      const revoked =
        this.db
          .prepare(
            `UPDATE invitations SET revoked_at = ?
             WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL AND consumed_at IS NULL`,
          )
          .run(this.clock().toISOString(), id, tenantId).changes > 0;
      const invitation = revoked ? this.get(tenantId, id) : undefined;
      if (invitation)
        new AuditLog(this.db).record({
          action: "invitation.revoke",
          actor,
          workspaceId: invitation.workspaceId,
          targetKind: "invitation",
          targetId: id,
          before: { role: invitation.role, targetKind: invitation.targetKind },
        });
      return revoked;
    })();
  }

  /** The open invitation a token names, without consuming it; undefined when not usable. */
  open(token: string): Invitation | undefined {
    if (token.length === 0 || token.length > 256) return undefined;
    const row = this.db
      .prepare(
        `SELECT * FROM invitations WHERE token_hash = ? AND consumed_at IS NULL
           AND revoked_at IS NULL AND expires_at > ?`,
      )
      .get(hashToken(token), this.clock().toISOString()) as InvitationRow | undefined;
    return row ? toInvitation(row) : undefined;
  }

  /**
   * The invitation a token names, usable or not, with why it is not (ADR-0022 amendment 4 I6).
   * Only a holder of the token can ask, so its state is no secret from them.
   */
  inspect(
    token: string,
  ): { invitation: Invitation; unusable?: "used" | "revoked" | "expired" } | undefined {
    if (token.length === 0 || token.length > 256) return undefined;
    const row = this.db
      .prepare("SELECT * FROM invitations WHERE token_hash = ?")
      .get(hashToken(token)) as InvitationRow | undefined;
    if (!row) return undefined;
    const invitation = toInvitation(row);
    const unusable = invitation.consumedAt
      ? "used"
      : invitation.revokedAt
        ? "revoked"
        : Date.parse(invitation.expiresAt) <= this.clock().getTime()
          ? "expired"
          : undefined;
    return unusable ? { invitation, unusable } : { invitation };
  }

  /** The open invitation with this id (an OIDC transaction carries the id, not the token). */
  openById(id: string): Invitation | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM invitations WHERE id = ? AND consumed_at IS NULL
           AND revoked_at IS NULL AND expires_at > ?`,
      )
      .get(id, this.clock().toISOString()) as InvitationRow | undefined;
    return row ? toInvitation(row) : undefined;
  }

  /**
   * Spend an invitation for `userId`: one update that succeeds only while it is unused,
   * unrevoked and unexpired, so of two concurrent acceptances exactly one wins. Call it inside
   * the transaction that writes the membership, so a failure there leaves it unspent.
   */
  consume(id: string, userId: string): boolean {
    const now = this.clock().toISOString();
    return (
      this.db
        .prepare(
          `UPDATE invitations SET consumed_at = ?, consumed_by_user_id = ?
           WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
        )
        .run(now, userId, id, now).changes === 1
    );
  }
}
