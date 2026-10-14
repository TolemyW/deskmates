// Query module for the integration tables of migration 0017 (ADR-0013 items 3, 4, 6 and 8). The
// Gateway's own truth about integrations: adopted providers, which workspace owns which runtime
// connection, per-workspace runtime token references, tier overrides and OAuth states in flight.
// No column holds a credential; the runtime token is in the Secrets Store.

import { createHash } from "node:crypto";
import {
  type AdoptedIntegrationProvider,
  DeskmatesError,
  type IntegrationActionOverride,
  type IntegrationAuthKind,
  type IntegrationConnection,
  type IntegrationConnectionId,
  type IntegrationConnectionStatus,
  type IntegrationTierOverride,
  type IsoTimestamp,
  type WorkspaceId,
} from "@deskmates/contracts";
import { AuditLog } from "../audit/audit-log.js";
import { newId, nowIso, parseJson } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";

interface ProviderRow {
  service: string;
  display_name: string;
  auth_kinds_json: string;
  adopted_at: string;
}

interface ConnectionRow {
  id: string;
  workspace_id: string;
  service: string;
  connection_name: string;
  runtime_connection_name: string;
  runtime_connection_id: string;
  auth_kind: IntegrationAuthKind;
  created_at: string;
  revoked_at: string | null;
}

interface OverrideRow {
  action_id: string;
  lowerable_to_l1: number;
  never_lowerable: number;
  updated_at: string;
}

/** A connection with the name the runtime knows it by; internal to the Gateway. */
export interface StoredIntegrationConnection extends IntegrationConnection {
  runtimeConnectionName: string;
}

export interface WorkspaceTokenRef {
  workspaceId: WorkspaceId;
  runtimeTokenId: string;
  secretId: string;
}

export interface PendingOAuthState {
  workspaceId: WorkspaceId;
  service: string;
  connectionName: string;
  runtimeConnectionName: string;
  /** The browser session that started the grant; absent for an operator-token start. */
  sessionId?: string;
}

function toProvider(row: ProviderRow): AdoptedIntegrationProvider {
  return {
    service: row.service,
    displayName: row.display_name,
    authKinds: parseJson<IntegrationAuthKind[]>(row.auth_kinds_json, []),
    adoptedAt: row.adopted_at,
  };
}

function toConnection(row: ConnectionRow): StoredIntegrationConnection {
  return {
    id: row.id as IntegrationConnectionId,
    workspaceId: row.workspace_id as WorkspaceId,
    service: row.service,
    connectionName: row.connection_name,
    runtimeConnectionId: row.runtime_connection_id,
    runtimeConnectionName: row.runtime_connection_name,
    authKind: row.auth_kind,
    createdAt: row.created_at,
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
  };
}

/** The contracts view of a connection: without the runtime's name for it. */
export function publicConnection(c: StoredIntegrationConnection): IntegrationConnection {
  const { runtimeConnectionName: _hidden, ...rest } = c;
  return rest;
}

export function stateHash(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

/**
 * The runtime's name for a workspace's connection. Runtime names are global per service and have
 * no tenant field (Amendment 1), so the workspace is folded in as a short hash prefix; the result
 * stays inside the runtime's `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`.
 */
export function runtimeConnectionName(workspaceId: WorkspaceId, connectionName: string): string {
  const prefix = createHash("sha256").update(workspaceId).digest("hex").slice(0, 10);
  return `g${prefix}-${connectionName}`;
}

export class IntegrationStore {
  constructor(private readonly db: GatewayDb) {}

  // --- providers -------------------------------------------------------------------------

  listProviders(): AdoptedIntegrationProvider[] {
    const rows = this.db
      .prepare("SELECT * FROM integration_providers ORDER BY service")
      .all() as ProviderRow[];
    return rows.map(toProvider);
  }

  provider(service: string): AdoptedIntegrationProvider | undefined {
    const row = this.db
      .prepare("SELECT * FROM integration_providers WHERE service = ?")
      .get(service) as ProviderRow | undefined;
    return row ? toProvider(row) : undefined;
  }

  adopt(
    service: string,
    displayName: string,
    authKinds: IntegrationAuthKind[],
  ): AdoptedIntegrationProvider {
    this.db
      .prepare(
        `INSERT INTO integration_providers (service, display_name, auth_kinds_json, adopted_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(service) DO UPDATE SET display_name = excluded.display_name,
           auth_kinds_json = excluded.auth_kinds_json`,
      )
      .run(service, displayName, JSON.stringify(authKinds), nowIso());
    return this.provider(service) as AdoptedIntegrationProvider;
  }

  unadopt(service: string): boolean {
    return (
      this.db.prepare("DELETE FROM integration_providers WHERE service = ?").run(service).changes >
      0
    );
  }

  // --- connections -----------------------------------------------------------------------

  insertConnection(input: {
    workspaceId: WorkspaceId;
    service: string;
    connectionName: string;
    runtimeConnectionName: string;
    runtimeConnectionId: string;
    authKind: IntegrationAuthKind;
    /** Who connected it, for the audit record; the OAuth callback names its flow. */
    actor?: string;
  }): StoredIntegrationConnection {
    const id = newId("icn");
    return this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO integration_connections (id, workspace_id, service, connection_name,
             runtime_connection_name, runtime_connection_id, auth_kind, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.workspaceId,
          input.service,
          input.connectionName,
          input.runtimeConnectionName,
          input.runtimeConnectionId,
          input.authKind,
          nowIso(),
        );
      new AuditLog(this.db).record({
        action: "integration.connect",
        actor: input.actor ?? "operator",
        workspaceId: input.workspaceId,
        targetKind: "integration_connection",
        targetId: id,
        after: {
          service: input.service,
          connectionName: input.connectionName,
          authKind: input.authKind,
        },
      });
      return this.mustGetConnection(id);
    })();
  }

  connection(id: string): StoredIntegrationConnection | undefined {
    const row = this.db.prepare("SELECT * FROM integration_connections WHERE id = ?").get(id) as
      | ConnectionRow
      | undefined;
    return row ? toConnection(row) : undefined;
  }

  mustGetConnection(id: string): StoredIntegrationConnection {
    const c = this.connection(id);
    if (!c)
      throw new DeskmatesError("not_found", `integration connection ${id} not found`, {
        connectionId: id,
      });
    return c;
  }

  /** Every connection of a workspace, revoked ones included, oldest first. */
  listConnections(workspaceId: WorkspaceId): StoredIntegrationConnection[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM integration_connections WHERE workspace_id = ? ORDER BY created_at, id",
      )
      .all(workspaceId) as ConnectionRow[];
    return rows.map(toConnection);
  }

  /**
   * One page of a workspace's connections, oldest first with the id as tie-breaker
   * (`created_at, id`), and the honest total under the same status filter (#113). Indexed by
   * `integration_connections_workspace (workspace_id, created_at, id)`.
   */
  connectionPage(
    workspaceId: WorkspaceId,
    status: IntegrationConnectionStatus | undefined,
    offset: number,
    limit: number,
  ): { connections: StoredIntegrationConnection[]; total: number } {
    const where =
      status === "live"
        ? "workspace_id = ? AND revoked_at IS NULL"
        : status === "revoked"
          ? "workspace_id = ? AND revoked_at IS NOT NULL"
          : "workspace_id = ?";
    const { total } = this.db
      .prepare(`SELECT COUNT(*) AS total FROM integration_connections WHERE ${where}`)
      .get(workspaceId) as { total: number };
    const rows = this.db
      .prepare(
        `SELECT * FROM integration_connections WHERE ${where}
         ORDER BY created_at, id LIMIT ? OFFSET ?`,
      )
      .all(workspaceId, limit, offset) as ConnectionRow[];
    return { connections: rows.map(toConnection), total };
  }

  /** Live connections per service over the whole workspace, by service name (#113). */
  liveConnectionCounts(workspaceId: WorkspaceId): { service: string; count: number }[] {
    return this.db
      .prepare(
        `SELECT service, COUNT(*) AS count FROM integration_connections
         WHERE workspace_id = ? AND revoked_at IS NULL GROUP BY service ORDER BY service`,
      )
      .all(workspaceId) as { service: string; count: number }[];
  }

  /**
   * The connections a run of this workspace may use: not revoked, of an adopted provider. This is
   * what the workspace's runtime token is granted and what the start request counts.
   */
  usableConnections(workspaceId: WorkspaceId): StoredIntegrationConnection[] {
    const rows = this.db
      .prepare(
        `SELECT c.* FROM integration_connections c
           JOIN integration_providers p ON p.service = c.service
         WHERE c.workspace_id = ? AND c.revoked_at IS NULL
         ORDER BY c.created_at, c.id`,
      )
      .all(workspaceId) as ConnectionRow[];
    return rows.map(toConnection);
  }

  liveConnectionNamed(
    workspaceId: WorkspaceId,
    service: string,
    connectionName: string,
  ): StoredIntegrationConnection | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM integration_connections
         WHERE workspace_id = ? AND service = ? AND connection_name = ? AND revoked_at IS NULL`,
      )
      .get(workspaceId, service, connectionName) as ConnectionRow | undefined;
    return row ? toConnection(row) : undefined;
  }

  revokeConnection(id: string, actor = "operator"): StoredIntegrationConnection {
    return this.db.transaction(() => {
      const changed = this.db
        .prepare(
          "UPDATE integration_connections SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
        )
        .run(nowIso(), id).changes;
      const connection = this.mustGetConnection(id);
      if (changed > 0)
        new AuditLog(this.db).record({
          action: "integration.revoke",
          actor,
          workspaceId: connection.workspaceId,
          targetKind: "integration_connection",
          targetId: id,
          before: { service: connection.service, connectionName: connection.connectionName },
        });
      return connection;
    })();
  }

  /** Workspaces that hold a runtime token, for a resync after an adoption change. */
  workspacesWithTokens(): WorkspaceId[] {
    return (
      this.db.prepare("SELECT workspace_id FROM integration_workspace_tokens").all() as {
        workspace_id: string;
      }[]
    ).map((r) => r.workspace_id as WorkspaceId);
  }

  /** Workspaces with at least one live connection. */
  workspacesWithConnections(): WorkspaceId[] {
    return (
      this.db
        .prepare(
          "SELECT DISTINCT workspace_id FROM integration_connections WHERE revoked_at IS NULL",
        )
        .all() as { workspace_id: string }[]
    ).map((r) => r.workspace_id as WorkspaceId);
  }

  // --- per-workspace runtime token ---------------------------------------------------------

  workspaceToken(workspaceId: WorkspaceId): WorkspaceTokenRef | undefined {
    const row = this.db
      .prepare("SELECT * FROM integration_workspace_tokens WHERE workspace_id = ?")
      .get(workspaceId) as
      | { workspace_id: string; runtime_token_id: string; secret_id: string }
      | undefined;
    return row
      ? {
          workspaceId: row.workspace_id as WorkspaceId,
          runtimeTokenId: row.runtime_token_id,
          secretId: row.secret_id,
        }
      : undefined;
  }

  setWorkspaceToken(workspaceId: WorkspaceId, runtimeTokenId: string, secretId: string): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO integration_workspace_tokens (workspace_id, runtime_token_id, secret_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET runtime_token_id = excluded.runtime_token_id,
           secret_id = excluded.secret_id, updated_at = excluded.updated_at`,
      )
      .run(workspaceId, runtimeTokenId, secretId, now, now);
  }

  touchWorkspaceToken(workspaceId: WorkspaceId): void {
    this.db
      .prepare("UPDATE integration_workspace_tokens SET updated_at = ? WHERE workspace_id = ?")
      .run(nowIso(), workspaceId);
  }

  deleteWorkspaceToken(workspaceId: WorkspaceId): void {
    this.db
      .prepare("DELETE FROM integration_workspace_tokens WHERE workspace_id = ?")
      .run(workspaceId);
  }

  // --- the Gateway's catalog token (ADR-0013 amendment 3) ----------------------------------

  catalogToken(): { runtimeTokenId: string; secretId: string } | undefined {
    const row = this.db
      .prepare("SELECT runtime_token_id, secret_id FROM integration_catalog_token WHERE id = 1")
      .get() as { runtime_token_id: string; secret_id: string } | undefined;
    return row ? { runtimeTokenId: row.runtime_token_id, secretId: row.secret_id } : undefined;
  }

  setCatalogToken(runtimeTokenId: string, secretId: string): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO integration_catalog_token (id, runtime_token_id, secret_id, created_at, updated_at)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET runtime_token_id = excluded.runtime_token_id,
           secret_id = excluded.secret_id, updated_at = excluded.updated_at`,
      )
      .run(runtimeTokenId, secretId, now, now);
  }

  // --- tier overrides --------------------------------------------------------------------

  override(actionId: string): IntegrationTierOverride {
    const row = this.db
      .prepare("SELECT * FROM integration_action_overrides WHERE action_id = ?")
      .get(actionId) as OverrideRow | undefined;
    return {
      lowerableToL1: row?.lowerable_to_l1 === 1,
      neverLowerable: row?.never_lowerable === 1,
    };
  }

  listOverrides(): IntegrationActionOverride[] {
    const rows = this.db
      .prepare("SELECT * FROM integration_action_overrides ORDER BY action_id")
      .all() as OverrideRow[];
    return rows.map((r) => ({
      actionId: r.action_id,
      lowerableToL1: r.lowerable_to_l1 === 1,
      neverLowerable: r.never_lowerable === 1,
      updatedAt: r.updated_at,
    }));
  }

  setOverride(actionId: string, override: IntegrationTierOverride): IntegrationActionOverride {
    const updatedAt: IsoTimestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO integration_action_overrides (action_id, lowerable_to_l1, never_lowerable, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(action_id) DO UPDATE SET lowerable_to_l1 = excluded.lowerable_to_l1,
           never_lowerable = excluded.never_lowerable, updated_at = excluded.updated_at`,
      )
      .run(actionId, override.lowerableToL1 ? 1 : 0, override.neverLowerable ? 1 : 0, updatedAt);
    return { actionId, ...override, updatedAt };
  }

  // --- OAuth states ----------------------------------------------------------------------

  recordOAuthState(state: string, pending: PendingOAuthState, ttlSeconds: number, now: Date): void {
    this.db
      .prepare(
        `INSERT INTO integration_oauth_states (state_hash, workspace_id, service, connection_name,
           runtime_connection_name, session_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        stateHash(state),
        pending.workspaceId,
        pending.service,
        pending.connectionName,
        pending.runtimeConnectionName,
        pending.sessionId ?? null,
        now.toISOString(),
        new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
      );
  }

  /**
   * Spend a state: returns what it was issued for when it is known, unused and unexpired, and
   * marks it used in the same statement, so a replayed callback finds nothing.
   */
  consumeOAuthState(state: string, now: Date): PendingOAuthState | undefined {
    const iso = now.toISOString();
    const row = this.db
      .prepare(
        `UPDATE integration_oauth_states SET used_at = ?
         WHERE state_hash = ? AND used_at IS NULL AND expires_at > ?
         RETURNING workspace_id, service, connection_name, runtime_connection_name, session_id`,
      )
      .get(iso, stateHash(state), iso) as
      | {
          workspace_id: string;
          service: string;
          connection_name: string;
          runtime_connection_name: string;
          session_id: string | null;
        }
      | undefined;
    return row
      ? {
          workspaceId: row.workspace_id as WorkspaceId,
          service: row.service,
          connectionName: row.connection_name,
          runtimeConnectionName: row.runtime_connection_name,
          ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
        }
      : undefined;
  }
}
