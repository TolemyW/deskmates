// The audit record (ADR-0031 decision 11): one append-only row per approval decision and per
// workspace-level configuration change, written in the caller's transaction. Personal
// preferences, profile, avatar and password are not audited. Values never carry a secret, token,
// cookie or message body: the writer redacts any field whose name says it holds one.

import { nowIso } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";

/** Every action the record knows; the baseline seeds `audit_actions` with exactly these. */
export const AUDIT_ACTIONS = [
  "approval.decide",
  "approval_rule.create",
  "approval_rule.delete",
  "bot.archive",
  "bot.create",
  "bot.purge",
  "bot.restore",
  "bot.update",
  "budget.continue",
  "budget.set",
  "channel.connect",
  "channel.disconnect",
  "connector.create",
  "cost_rule.create",
  "cost_rule.delete",
  "egress.allowlist_set",
  "file.upload",
  "integration.connect",
  "integration.revoke",
  "invitation.create",
  "invitation.revoke",
  "membership.add",
  "membership.remove",
  "membership.role",
  "memory.review_batch",
  "memory.review_batch_undo",
  "network_policy.publish",
  "network_profile.create",
  "network_profile.delete",
  "network_profile.update",
  "service_principal.create",
  "service_principal.disable",
  "service_principal.rotate",
  "task.delete",
  "task.run",
  "task.schedule_set",
  "workspace.archive",
  "workspace.auto_approval_set",
  "workspace.create",
  "workspace.limits_set",
  "workspace.network_profiles_set",
  "workspace.purge",
  "workspace.restore",
  "workspace.update",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntry {
  action: AuditAction;
  /** The actor label (`user:<id>`, `service:<id>`, `bot:<id>`, `rule:<id>`, `web`, ...). */
  actor: string;
  /** The workspace the change belongs to; its tenant is looked up. */
  workspaceId?: string;
  /** For a change outside any workspace (an installation-level role, a principal). */
  tenantId?: string;
  targetKind: string;
  targetId: string;
  before?: unknown;
  after?: unknown;
  runId?: string;
  reason?: string;
}

export interface AuditEvent {
  seq: number;
  tenantId: string;
  workspaceId: string | null;
  occurredAt: string;
  actor: string;
  actorUserId: string | null;
  action: AuditAction;
  targetKind: string;
  targetId: string;
  before: unknown;
  after: unknown;
  runId: string | null;
  reason: string | null;
}

/** Field names whose values are credentials or content; their values never reach the record. */
const REDACTED_FIELD = /secret|token|password|cookie|credential|api[-_]?key|authorization|body$/i;

/** A copy of `value` with every credential-like or content field replaced by "[redacted]". */
export function redactAuditValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAuditValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, field]) => [
        key,
        REDACTED_FIELD.test(key) && field !== null && field !== undefined
          ? "[redacted]"
          : redactAuditValue(field),
      ]),
    );
  }
  return value;
}

function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(redactAuditValue(value));
}

export class AuditLog {
  constructor(private readonly db: GatewayDb) {}

  /** Appends one row. Call it inside the transaction that makes the change. */
  record(entry: AuditEntry): void {
    const tenantId =
      entry.tenantId ??
      (entry.workspaceId
        ? (
            this.db
              .prepare("SELECT tenant_id FROM workspaces WHERE id = ?")
              .get(entry.workspaceId) as { tenant_id: string } | undefined
          )?.tenant_id
        : undefined);
    if (!tenantId) throw new Error(`audit ${entry.action}: no tenant for the change`);
    const userId = /^user:(.+)$/.exec(entry.actor)?.[1] ?? null;
    this.db
      .prepare(
        `INSERT INTO audit_events (tenant_id, workspace_id, occurred_at, actor, actor_user_id,
           action, target_kind, target_id, before_json, after_json, run_id, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        tenantId,
        entry.workspaceId ?? null,
        nowIso(),
        entry.actor,
        userId,
        entry.action,
        entry.targetKind,
        entry.targetId,
        json(entry.before),
        json(entry.after),
        entry.runId ?? null,
        entry.reason ?? null,
      );
  }

  /** Newest first; for tests and the later browsing page. */
  list(filter: { workspaceId?: string; targetId?: string } = {}): AuditEvent[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.workspaceId) {
      clauses.push("workspace_id = ?");
      params.push(filter.workspaceId);
    }
    if (filter.targetId) {
      clauses.push("target_id = ?");
      params.push(filter.targetId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM audit_events ${where} ORDER BY seq DESC`)
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      seq: row.seq as number,
      tenantId: row.tenant_id as string,
      workspaceId: row.workspace_id as string | null,
      occurredAt: row.occurred_at as string,
      actor: row.actor as string,
      actorUserId: row.actor_user_id as string | null,
      action: row.action as AuditAction,
      targetKind: row.target_kind as string,
      targetId: row.target_id as string,
      before: row.before_json === null ? null : JSON.parse(row.before_json as string),
      after: row.after_json === null ? null : JSON.parse(row.after_json as string),
      runId: row.run_id as string | null,
      reason: row.reason as string | null,
    }));
  }
}
