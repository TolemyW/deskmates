// Workspace registry: one row per container (ADR-0004). The egress allowlist is stored in
// `egress_rules` and returned on the workspace; M1 lets an operator replace it, and the agent
// never can.

import {
  DeskmatesError,
  type LoginProbe,
  type SandboxProviderKind,
  type SandboxRestorationRequirement,
  type Workspace,
  type WorkspaceId,
  type WorkspaceStatus,
  describeWorkspaceNameProblem,
  egressAllowlistProblem,
  workspaceNameProblem,
} from "@deskmates/contracts";
import { AuditLog } from "../audit/audit-log.js";
import { DEFAULT_TENANT_ID } from "../auth/user-store.js";
import { newId, nowIso, parseJson } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";
import { WorkspaceMembershipStore } from "./memberships.js";

interface WorkspaceRow {
  id: string;
  name: string;
  sandbox_provider: SandboxProviderKind;
  status: WorkspaceStatus;
  probe_url: string | null;
  probe_rule_json: string | null;
  egress_updated_at: string | null;
  created_at: string;
  archived_at: string | null;
  archived_by: string | null;
  restoration_requirements_json?: string | null;
}

/**
 * The patterns, deduplicated in the order they were given, or a `validation` error naming the
 * first unusable one. Create and the PATCH route share this: an allowlist that is accepted on
 * one path and refused on the other is a trap for the operator who edits it.
 */
function validPatterns(patterns: readonly string[]): string[] {
  const problem = egressAllowlistProblem(patterns);
  if (problem !== undefined) throw new DeskmatesError("validation", problem);
  return [...new Set(patterns)];
}

/**
 * The NFC form of a valid new or renamed name, or a `validation` error naming the field, its
 * weighted width and the limit (ADR-0034 decisions 1 and 2). A name is never trimmed or cut.
 */
export function validWorkspaceName(name: string): string {
  const problem = workspaceNameProblem(name);
  if (problem !== undefined)
    throw new DeskmatesError("validation", describeWorkspaceNameProblem(problem), {
      field: "name",
      reason: problem.code,
      ...(problem.code === "too_long" ? { units: problem.units, max: problem.max } : {}),
    });
  return name.normalize("NFC");
}

export interface CreateWorkspaceInput {
  name: string;
  sandboxProvider: SandboxProviderKind;
  probe?: LoginProbe;
  egressAllowlist?: readonly string[];
  createdBy?: string;
  /** Owning tenant; omitted means the Default Tenant (single-tenant installations, tests). */
  tenantId?: string;
  /** The person creating it, who becomes its Owner. */
  ownerUserId?: string;
}

export class WorkspaceStore {
  constructor(private readonly db: GatewayDb) {}

  create(input: CreateWorkspaceInput): Workspace {
    const name = validWorkspaceName(input.name);
    const id = newId("ws") as WorkspaceId;
    const createdAt = nowIso();
    const patterns = validPatterns(input.egressAllowlist ?? []);
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO workspaces (id, tenant_id, name, sandbox_provider, status, probe_url, probe_rule_json, egress_updated_at, created_at) VALUES (?, ?, ?, ?, 'ready', ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.tenantId ?? DEFAULT_TENANT_ID,
          name,
          input.sandboxProvider,
          input.probe?.url ?? null,
          input.probe ? JSON.stringify({ expectText: input.probe.expectText }) : null,
          createdAt,
          createdAt,
        );
      const insertRule = this.db.prepare(
        "INSERT INTO egress_rules (workspace_id, domain_pattern, created_by, created_at) VALUES (?, ?, ?, ?)",
      );
      for (const pattern of patterns) {
        insertRule.run(id, pattern, input.createdBy ?? "operator", createdAt);
      }
      // The creator becomes its Owner in the same transaction (ADR-0031 decision 7); the
      // protected account is made Owner by the schema.
      if (input.ownerUserId !== undefined)
        new WorkspaceMembershipStore(this.db).add(
          id,
          input.ownerUserId,
          "owner",
          input.createdBy ?? "operator",
        );
      new AuditLog(this.db).record({
        action: "workspace.create",
        actor: input.createdBy ?? "operator",
        workspaceId: id,
        targetKind: "workspace",
        targetId: id,
        after: {
          name,
          sandboxProvider: input.sandboxProvider,
          egressAllowlist: patterns,
          ...(input.probe ? { probeUrl: input.probe.url } : {}),
        },
      });
    })();
    return this.mustGet(id);
  }

  /**
   * Replaces the workspace's allowlist in one transaction and dates the change. The list is
   * human-maintained (AGENTS.md "Egress is deny-by-default"): this is reached from the operator
   * route only, never from a tool. Every pattern is validated before the first row is deleted,
   * so a bad one leaves the workspace exactly as it was.
   */
  setEgressAllowlist(id: WorkspaceId, patterns: readonly string[], createdBy: string): Workspace {
    const before = this.mustGet(id).egressAllowlist;
    const valid = validPatterns(patterns);
    const at = nowIso();
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM egress_rules WHERE workspace_id = ?").run(id);
      const insertRule = this.db.prepare(
        "INSERT INTO egress_rules (workspace_id, domain_pattern, created_by, created_at) VALUES (?, ?, ?, ?)",
      );
      for (const pattern of valid) insertRule.run(id, pattern, createdBy, at);
      this.db.prepare("UPDATE workspaces SET egress_updated_at = ? WHERE id = ?").run(at, id);
      new AuditLog(this.db).record({
        action: "egress.allowlist_set",
        actor: createdBy,
        workspaceId: id,
        targetKind: "workspace",
        targetId: id,
        before: { egressAllowlist: before },
        after: { egressAllowlist: valid },
      });
    })();
    return this.mustGet(id);
  }

  /**
   * Rename a workspace (ADR-0034 decision 2). The name already stored is accepted unchanged, even
   * a legacy one over the bound, so an unrelated edit never fails on it; a different name must be
   * valid. The change is audited as `workspace.update` in the same transaction.
   */
  rename(id: WorkspaceId, name: string, actor: string): Workspace {
    const before = this.mustGet(id);
    if (name === before.name) return before;
    const next = validWorkspaceName(name);
    if (next === before.name) return before;
    this.db.transaction(() => {
      this.db.prepare("UPDATE workspaces SET name = ? WHERE id = ?").run(next, id);
      new AuditLog(this.db).record({
        action: "workspace.update",
        actor,
        workspaceId: id,
        targetKind: "workspace",
        targetId: id,
        before: { name: before.name },
        after: { name: next },
      });
    })();
    return this.mustGet(id);
  }

  /**
   * Merge notices by prerequisite identity (code, path, source runtime): a newer status for the
   * same prerequisite replaces the older one, other notices stay. With `inspectionComplete` the
   * given `at_risk` entries are the whole inspection of the current runtime, so a stored
   * `at_risk` entry it no longer finds is resolved and dropped. Historical
   * `restoration_required` / `replacement_outcome_unknown` notices are never cleared here.
   */
  recordRestorationRequirements(
    id: WorkspaceId,
    requirements: readonly SandboxRestorationRequirement[],
    options: { inspectionComplete?: boolean } = {},
  ): void {
    const stored = this.mustGet(id).restorationRequirements ?? [];
    if (requirements.length === 0 && !options.inspectionComplete) return;
    const identity = (r: SandboxRestorationRequirement) =>
      JSON.stringify([r.code, r.path, r.sourceProviderRef]);
    const incoming = new Set(requirements.map(identity));
    const merged = new Map<string, SandboxRestorationRequirement>();
    for (const r of stored)
      if (!(options.inspectionComplete && r.status === "at_risk" && !incoming.has(identity(r))))
        merged.set(identity(r), r);
    for (const r of requirements) merged.set(identity(r), { ...r });
    const next = [...merged.values()];
    this.db
      .prepare("UPDATE workspaces SET restoration_requirements_json = ? WHERE id = ?")
      .run(next.length ? JSON.stringify(next) : null, id);
  }

  get(id: WorkspaceId): Workspace | undefined {
    const row = this.db
      .prepare("SELECT * FROM workspaces WHERE id = ? AND archived_at IS NULL")
      .get(id) as WorkspaceRow | undefined;
    return row ? this.toWorkspace(row) : undefined;
  }

  mustGet(id: WorkspaceId): Workspace {
    const ws = this.get(id);
    if (!ws)
      throw new DeskmatesError("not_found", `workspace ${id} not found`, { workspaceId: id });
    return ws;
  }

  mustGetIncludingArchived(id: WorkspaceId): Workspace {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as
      | WorkspaceRow
      | undefined;
    const ws = row ? this.toWorkspace(row) : undefined;
    if (!ws)
      throw new DeskmatesError("not_found", `workspace ${id} not found`, { workspaceId: id });
    return ws;
  }

  /** With a tenant, that tenant's workspaces only (ADR-0022 P2); without, all (internal use). */
  list(tenantId?: string): Workspace[] {
    const active = "archived_at IS NULL";
    const rows = (
      tenantId === undefined
        ? this.db.prepare(`SELECT * FROM workspaces WHERE ${active} ORDER BY created_at, id`).all()
        : this.db
            .prepare(
              `SELECT * FROM workspaces WHERE tenant_id = ? AND ${active} ORDER BY created_at, id`,
            )
            .all(tenantId)
    ) as WorkspaceRow[];
    return rows.map((r) => this.toWorkspace(r));
  }

  listArchived(tenantId: string): Workspace[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM workspaces WHERE tenant_id = ? AND archived_at IS NOT NULL ORDER BY archived_at DESC, id",
        )
        .all(tenantId) as WorkspaceRow[]
    ).map((row) => this.toWorkspace(row));
  }

  archive(id: WorkspaceId, actor: string): Workspace {
    const current = this.mustGetIncludingArchived(id);
    if (!current.archivedAt) {
      this.db
        .prepare("UPDATE workspaces SET archived_at = ?, archived_by = ? WHERE id = ?")
        .run(nowIso(), actor, id);
    }
    return this.mustGetIncludingArchived(id);
  }

  restore(id: WorkspaceId): Workspace {
    const current = this.mustGetIncludingArchived(id);
    if (!current.archivedAt) return current;
    this.db
      .prepare("UPDATE workspaces SET archived_at = NULL, archived_by = NULL WHERE id = ?")
      .run(id);
    return this.mustGet(id);
  }

  egressAllowlist(id: WorkspaceId): string[] {
    return (
      this.db
        .prepare("SELECT domain_pattern FROM egress_rules WHERE workspace_id = ? ORDER BY id")
        .all(id) as { domain_pattern: string }[]
    ).map((r) => r.domain_pattern);
  }

  private toWorkspace(row: WorkspaceRow): Workspace {
    const ws: Workspace = {
      id: row.id as WorkspaceId,
      name: row.name,
      sandboxProvider: row.sandbox_provider,
      status: row.status,
      egressAllowlist: this.egressAllowlist(row.id as WorkspaceId),
      createdAt: row.created_at,
      ...(row.egress_updated_at === null ? {} : { egressUpdatedAt: row.egress_updated_at }),
      ...(row.archived_at == null ? {} : { archivedAt: row.archived_at }),
      ...(row.archived_by == null ? {} : { archivedBy: row.archived_by }),
    };
    if (row.restoration_requirements_json) {
      ws.restorationRequirements = parseJson<SandboxRestorationRequirement[]>(
        row.restoration_requirements_json,
        [],
      );
    }
    if (row.probe_url !== null) {
      const rule = parseJson<{ expectText?: string }>(row.probe_rule_json, {});
      ws.probe = { url: row.probe_url, expectText: rule.expectText ?? "" };
    }
    return ws;
  }
}
