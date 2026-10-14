// The workspace directory (ADR-0034 decisions 3, 5 and 6): one bounded SQL query per page, with
// the caller's role, their own pin and authorized per-row aggregates. Nothing is counted from a
// page and nothing is fetched per row. Pins are the caller's own and never audited.

import {
  DeskmatesError,
  type TenantRole,
  type WorkspaceDirectoryEntry,
  type WorkspaceDirectoryFilter,
  type WorkspaceId,
} from "@deskmates/contracts";
import { nowIso } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";

/** Who is asking: their user id (for pins and private chats) and a role that covers every row. */
export interface DirectoryViewer {
  userId?: string;
  /**
   * The role the caller holds in every workspace of the tenant (operator credential, protected
   * account, service principal). Undefined: a person, whose rows are their memberships.
   */
  everywhere?: TenantRole;
}

export interface DirectoryQuery {
  tenantId: string;
  viewer: DirectoryViewer;
  q?: string;
  filter: WorkspaceDirectoryFilter;
  role?: TenantRole;
  offset: number;
  limit: number;
}

/** Run statuses that count as running work: the run is not over. */
const ACTIVE_RUN_STATUSES = [
  "queued",
  "running",
  "waiting_approval_live",
  "waiting_approval",
  "waiting_browser",
  "waiting_continuation",
] as const;

interface DirectoryRow {
  id: string;
  name: string;
  created_at: string;
  archived_at: string | null;
  my_role: TenantRole;
  pinned: number;
  bot_count: number;
  active_runs: number;
  last_activity_at: string;
  open_internet: number;
}

function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export class WorkspaceDirectory {
  constructor(private readonly db: GatewayDb) {}

  page(query: DirectoryQuery): { workspaces: WorkspaceDirectoryEntry[]; total: number } {
    const { where, params } = this.filters(query);
    const from = `FROM workspaces w
      LEFT JOIN workspace_memberships m
        ON m.workspace_id = w.id AND m.user_id = @userId AND m.status = 'active'
      LEFT JOIN workspace_pins p ON p.workspace_id = w.id AND p.user_id = @userId
      WHERE ${where}`;
    const total = (this.db.prepare(`SELECT COUNT(*) AS n ${from}`).get(params) as { n: number }).n;
    const statuses = ACTIVE_RUN_STATUSES.map((s) => `'${s}'`).join(", ");
    const rows = this.db
      .prepare(
        `SELECT w.id, w.name, w.created_at, w.archived_at,
           COALESCE(@everywhere, m.role) AS my_role,
           p.pinned_at IS NOT NULL AS pinned,
           (SELECT COUNT(*) FROM bots b
              WHERE b.workspace_id = w.id AND b.archived_at IS NULL) AS bot_count,
           (SELECT COUNT(*) FROM runs r
              WHERE r.workspace_id = w.id AND r.status IN (${statuses})) AS active_runs,
           COALESCE((SELECT MAX(t.updated_at) FROM threads t
              WHERE t.workspace_id = w.id AND t.kind = 'chat'
                AND (t.private_to_user_id IS NULL OR t.private_to_user_id = @userId)),
             w.created_at) AS last_activity_at,
           (EXISTS (SELECT 1 FROM egress_rules e
                     WHERE e.workspace_id = w.id AND e.domain_pattern = '*')
            AND NOT EXISTS (SELECT 1 FROM egress_rules e
                     WHERE e.workspace_id = w.id AND e.domain_pattern <> '*')) AS open_internet
         ${from}
         ORDER BY last_activity_at DESC, w.id
         LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit: query.limit, offset: query.offset }) as DirectoryRow[];
    return { workspaces: rows.map(toEntry), total };
  }

  /** Pin or unpin a workspace for one person. Idempotent. */
  setPinned(userId: string, workspaceId: WorkspaceId, pinned: boolean): void {
    if (pinned)
      this.db
        .prepare(
          "INSERT INTO workspace_pins (user_id, workspace_id, pinned_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
        )
        .run(userId, workspaceId, nowIso());
    else
      this.db
        .prepare("DELETE FROM workspace_pins WHERE user_id = ? AND workspace_id = ?")
        .run(userId, workspaceId);
  }

  private filters(query: DirectoryQuery): {
    where: string;
    params: Record<string, string | null>;
  } {
    const clauses = ["w.tenant_id = @tenantId", "COALESCE(@everywhere, m.role) IS NOT NULL"];
    const params: Record<string, string | null> = {
      tenantId: query.tenantId,
      userId: query.viewer.userId ?? null,
      everywhere: query.viewer.everywhere ?? null,
    };
    if (query.filter === "archived") {
      // As the trash: archived workspaces are listed to their Admins and Owners only.
      clauses.push(
        "w.archived_at IS NOT NULL",
        "COALESCE(@everywhere, m.role) IN ('owner', 'admin')",
      );
    } else {
      clauses.push("w.archived_at IS NULL");
      if (query.filter === "pinned") {
        if (query.viewer.userId === undefined)
          throw new DeskmatesError(
            "validation",
            "pins belong to a person; this principal has none",
            {
              field: "filter",
            },
          );
        clauses.push("p.pinned_at IS NOT NULL");
      }
    }
    if (query.role !== undefined) {
      clauses.push("COALESCE(@everywhere, m.role) = @role");
      params.role = query.role;
    }
    const q = query.q?.normalize("NFC").trim();
    if (q) {
      clauses.push("(w.name LIKE @like ESCAPE '\\' OR w.id = @q)");
      params.like = likePattern(q);
      params.q = q;
    }
    return { where: clauses.join(" AND "), params };
  }
}

function toEntry(row: DirectoryRow): WorkspaceDirectoryEntry {
  const seesRuns = row.my_role === "owner" || row.my_role === "admin";
  return {
    id: row.id as WorkspaceId,
    name: row.name,
    myRole: row.my_role,
    pinned: row.pinned === 1,
    botCount: row.bot_count,
    activeRuns: seesRuns ? row.active_runs : null,
    lastActivityAt: row.last_activity_at,
    createdAt: row.created_at,
    ...(row.archived_at === null ? {} : { archivedAt: row.archived_at }),
    openInternet: row.open_internet === 1,
  };
}
