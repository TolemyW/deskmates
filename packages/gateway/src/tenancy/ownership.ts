// Which tenant owns a row (ADR-0022 P2). Every tenant-owned resource resolves to exactly one
// tenant with one SQL lookup: through its workspace, or through its own `tenant_id` where it has
// no workspace. The route guard and every scoped query use these, so "whose is this?" has one
// answer in one place. A missing row and a row of another tenant are the same: undefined.

import { DeskmatesError } from "@deskmates/contracts";
import type { GatewayDb } from "../db/open.js";

export const OWNED_KINDS = [
  "workspace",
  "bot",
  "thread",
  "run",
  "approval",
  "approvalRule",
  "memoryEntry",
  "memorySuggestion",
  "costAlertRule",
  "costAlert",
  "connector",
  "knowledgeDoc",
  "knowledgeProposal",
  "integrationConnection",
  "servicePrincipal",
  "skill",
] as const;
export type OwnedKind = (typeof OWNED_KINDS)[number];

const WS = "JOIN workspaces w ON w.id";

/** One statement per kind; each selects the owning tenant of the row with the given id. */
export const OWNER_SQL: Readonly<Record<OwnedKind, string>> = {
  workspace: "SELECT tenant_id FROM workspaces WHERE id = ?",
  bot: `SELECT w.tenant_id FROM bots b ${WS} = b.workspace_id WHERE b.id = ?`,
  thread: `SELECT w.tenant_id FROM threads t ${WS} = t.workspace_id WHERE t.id = ?`,
  run: `SELECT w.tenant_id FROM runs r ${WS} = r.workspace_id WHERE r.id = ?`,
  approval: `SELECT w.tenant_id FROM approvals a ${WS} = a.workspace_id WHERE a.id = ?`,
  approvalRule: `SELECT w.tenant_id FROM approval_rules ar ${WS} = ar.workspace_id WHERE ar.id = ?`,
  memoryEntry: `SELECT w.tenant_id FROM memory_entries m ${WS} = m.workspace_id WHERE m.id = ?`,
  memorySuggestion: `SELECT w.tenant_id FROM memory_suggestions s ${WS} = s.workspace_id WHERE s.id = ?`,
  costAlertRule: `SELECT w.tenant_id FROM cost_alert_rules c ${WS} = c.workspace_id WHERE c.id = ?`,
  costAlert: `SELECT w.tenant_id FROM cost_alerts c ${WS} = c.workspace_id WHERE c.id = ?`,
  connector: `SELECT w.tenant_id FROM connectors c ${WS} = c.workspace_id WHERE c.id = ?`,
  knowledgeDoc: "SELECT tenant_id FROM knowledge_docs WHERE id = ?",
  knowledgeProposal: "SELECT tenant_id FROM knowledge_proposals WHERE id = ?",
  integrationConnection: `SELECT w.tenant_id FROM integration_connections ic ${WS} = ic.workspace_id WHERE ic.id = ?`,
  servicePrincipal: "SELECT tenant_id FROM service_principals WHERE id = ?",
  skill: `SELECT w.tenant_id FROM skills s ${WS} = s.workspace_id WHERE s.id = ?`,
};

/** The SQL fragment that restricts `alias.workspace_id` to one tenant's workspaces. */
export const WORKSPACES_OF_TENANT = "SELECT id FROM workspaces WHERE tenant_id = ?";

/**
 * The workspace a row belongs to, for the kinds that have one; roles are per workspace
 * (ADR-0031 decision 7). Knowledge and service principals are tenant-wide and have none.
 */
export const WORKSPACE_SQL: Readonly<Partial<Record<OwnedKind, string>>> = {
  workspace: "SELECT id AS workspace_id FROM workspaces WHERE id = ?",
  bot: "SELECT workspace_id FROM bots WHERE id = ?",
  thread: "SELECT workspace_id FROM threads WHERE id = ?",
  run: "SELECT workspace_id FROM runs WHERE id = ?",
  approval: "SELECT workspace_id FROM approvals WHERE id = ?",
  approvalRule: "SELECT workspace_id FROM approval_rules WHERE id = ?",
  memoryEntry: "SELECT workspace_id FROM memory_entries WHERE id = ?",
  memorySuggestion: "SELECT workspace_id FROM memory_suggestions WHERE id = ?",
  costAlertRule: "SELECT workspace_id FROM cost_alert_rules WHERE id = ?",
  costAlert: "SELECT workspace_id FROM cost_alerts WHERE id = ?",
  connector: "SELECT workspace_id FROM connectors WHERE id = ?",
  integrationConnection: "SELECT workspace_id FROM integration_connections WHERE id = ?",
  skill: "SELECT workspace_id FROM skills WHERE id = ?",
};

/**
 * The conversation a row belongs to, for the kinds that hang off one: its private audience and
 * its kind (ADR-0022 amendment 6 W6, W7). The audience is read from the thread only, never
 * copied onto child rows (ADR-0031 decision 9). No row: the row has no conversation.
 */
export const CONVERSATION_SQL: Readonly<Partial<Record<OwnedKind, string>>> = {
  thread: "SELECT private_to_user_id AS private_to, kind FROM threads WHERE id = ?",
  run: `SELECT t.private_to_user_id AS private_to, t.kind FROM runs r
          JOIN threads t ON t.id = r.thread_id WHERE r.id = ?`,
  approval: `SELECT t.private_to_user_id AS private_to, t.kind FROM approvals a
               JOIN runs r ON r.id = a.run_id JOIN threads t ON t.id = r.thread_id WHERE a.id = ?`,
};

/** The conversation facts of a row: who alone reads it (null: the workspace) and its kind. */
export interface ConversationFacts {
  privateTo: string | null;
  kind: "chat" | "bus";
}

export class Ownership {
  private readonly statements = new Map<OwnedKind, ReturnType<GatewayDb["prepare"]>>();

  /** The conversation a thread, run or approval belongs to; undefined when it has none. */
  conversationOf(kind: OwnedKind, id: string): ConversationFacts | undefined {
    const sql = CONVERSATION_SQL[kind];
    if (!sql) return undefined;
    const row = this.db.prepare(sql).get(id) as
      | { private_to: string | null; kind: "chat" | "bus" }
      | undefined;
    return row ? { privateTo: row.private_to, kind: row.kind } : undefined;
  }

  constructor(private readonly db: GatewayDb) {}

  /** The tenant that owns this row, or undefined when there is no such row. */
  tenantOf(kind: OwnedKind, id: string): string | undefined {
    let statement = this.statements.get(kind);
    if (!statement) {
      statement = this.db.prepare(OWNER_SQL[kind]);
      this.statements.set(kind, statement);
    }
    const row = statement.get(id) as { tenant_id: string | null } | undefined;
    return row?.tenant_id ?? undefined;
  }

  /**
   * Refuse unless `tenantId` owns the row. Missing and foreign are deliberately the same
   * answer, so a caller cannot probe another tenant's identifiers.
   */
  require(tenantId: string, kind: OwnedKind, id: string): void {
    if (typeof id !== "string" || id.length === 0 || this.tenantOf(kind, id) !== tenantId)
      throw new DeskmatesError("not_found", "Not found");
  }

  /** The workspace a row belongs to, or undefined for a tenant-wide kind or a missing row. */
  workspaceOf(kind: OwnedKind, id: string): string | undefined {
    const sql = WORKSPACE_SQL[kind];
    if (!sql) return undefined;
    const row = this.db.prepare(sql).get(id) as { workspace_id: string } | undefined;
    return row?.workspace_id;
  }

  /** The tenant of the run a run token belongs to; internal routes act inside it. */
  runTenant(runId: string): string {
    const tenant = this.tenantOf("run", runId);
    if (!tenant) throw new DeskmatesError("not_found", "Not found");
    return tenant;
  }

  /** The workspace ids of one tenant, for list routes that take no workspace filter. */
  workspaceIds(tenantId: string): Set<string> {
    return new Set(
      (this.db.prepare(WORKSPACES_OF_TENANT).all(tenantId) as Array<{ id: string }>).map(
        (row) => row.id,
      ),
    );
  }
}
