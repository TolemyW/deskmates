import {
  type BotId,
  type ChannelConnection,
  type ChannelConnectionStatus,
  type ChannelIdentity,
  DeskmatesError,
  type WorkspaceId,
  channelPendingIdentityKey,
  isPendingChannelIdentityKey,
} from "@deskmates/contracts";
import { newId, nowIso, parseJson } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";

interface ConnectionRow {
  id: string;
  workspace_id: string;
  plugin_id: string;
  plugin_version: string;
  api_version: number;
  method: string;
  bot_id: string;
  config_json: string;
  secret_id: string | null;
  phase: string;
  message: string | null;
  account: string | null;
  details_json: string;
  // The schema names the verified identity `account_*` (ADR-0004 item 4 keeps the word out).
  account_key: string | null;
  account_label: string | null;
  binding_generation: number;
  credential_generation: number;
  multiple_connections: number;
  admission_changed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface StoredChannelConnection extends ChannelConnection {
  secretId?: string;
  apiVersion: number;
  bindingGeneration: number;
  credentialGeneration: number;
  multipleConnections: boolean;
  /** A `link` connection whose plugin has not yet claimed its identity (ADR-0047 amendment 1). */
  identityPending?: boolean;
}

function fromRow(row: ConnectionRow): StoredChannelConnection {
  return {
    id: row.id,
    workspaceId: row.workspace_id as WorkspaceId,
    pluginId: row.plugin_id,
    pluginVersion: row.plugin_version,
    method: row.method,
    botId: row.bot_id as BotId,
    config: parseJson<Record<string, unknown>>(row.config_json, {}),
    status: {
      phase: row.phase,
      ...(row.message ? { message: row.message } : {}),
      ...(row.account ? { account: row.account } : {}),
      details: parseJson<Record<string, string | number | boolean | null>>(row.details_json, {}),
    },
    apiVersion: row.api_version,
    ...(row.account_key ? { identityKey: row.account_key } : {}),
    ...(isPendingChannelIdentityKey(row.account_key) ? { identityPending: true } : {}),
    ...(row.account_label ? { identityLabel: row.account_label } : {}),
    bindingGeneration: row.binding_generation,
    credentialGeneration: row.credential_generation,
    multipleConnections: row.multiple_connections === 1,
    ...(row.secret_id ? { secretId: row.secret_id } : {}),
    ...(row.admission_changed_at ? { admissionChangedAt: row.admission_changed_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * What a response may carry: no secret reference; generations only for ABI-2 connections; no
 * pending key, which is a placeholder, not an identity.
 */
export function publicChannelConnection(connection: StoredChannelConnection): ChannelConnection {
  const {
    secretId: _secretId,
    credentialGeneration: _credentialGeneration,
    multipleConnections: _multipleConnections,
    identityPending,
    identityKey,
    identityLabel,
    apiVersion,
    bindingGeneration,
    ...safe
  } = connection;
  const identity = identityPending
    ? {}
    : {
        ...(identityKey ? { identityKey } : {}),
        ...(identityLabel ? { identityLabel } : {}),
      };
  return apiVersion === 2 ? { ...safe, ...identity, apiVersion, bindingGeneration } : safe;
}

function identityInUse(pluginId: string): DeskmatesError {
  return new DeskmatesError(
    "channel_identity_in_use",
    "This account is already connected to an Agent in this installation. Disconnect it there first, or connect a different account.",
    { pluginId },
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE" &&
    /channel_connections/.test(error.message)
  );
}

export class ChannelStore {
  constructor(private readonly db: GatewayDb) {}

  list(workspaceId?: WorkspaceId): StoredChannelConnection[] {
    const rows = (
      workspaceId
        ? this.db
            .prepare("SELECT * FROM channel_connections WHERE workspace_id = ? ORDER BY created_at")
            .all(workspaceId)
        : this.db.prepare("SELECT * FROM channel_connections ORDER BY created_at").all()
    ) as ConnectionRow[];
    return rows.map(fromRow);
  }

  get(id: string): StoredChannelConnection | undefined {
    const row = this.db.prepare("SELECT * FROM channel_connections WHERE id = ?").get(id) as
      | ConnectionRow
      | undefined;
    return row ? fromRow(row) : undefined;
  }

  /** The connection `id` of `workspaceId`; another workspace's id is the same 404. */
  mustGetInWorkspace(workspaceId: WorkspaceId, id: string): StoredChannelConnection {
    const connection = this.get(id);
    if (!connection || connection.workspaceId !== workspaceId)
      throw new DeskmatesError("not_found", "channel connection not found");
    return connection;
  }

  /** Every connection of a plugin in a workspace, oldest first. */
  forPluginAll(workspaceId: WorkspaceId, pluginId: string): StoredChannelConnection[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM channel_connections WHERE workspace_id = ? AND plugin_id = ? ORDER BY created_at, id",
        )
        .all(workspaceId, pluginId) as ConnectionRow[]
    ).map(fromRow);
  }

  /** The plugin-addressed routes' connection: the only one, or none when there are several. */
  forPlugin(workspaceId: WorkspaceId, pluginId: string): StoredChannelConnection | undefined {
    const all = this.forPluginAll(workspaceId, pluginId);
    return all.length === 1 ? all[0] : undefined;
  }

  /**
   * Active workspaces holding a connection of `pluginId`: the reach of its ABI-1 plugin-wide host.
   * A workspace in Trash is out of reach (ADR-0017 amendment 1 P6).
   */
  workspacesOf(pluginId: string): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT c.workspace_id FROM channel_connections c
           JOIN workspaces w ON w.id = c.workspace_id
          WHERE c.plugin_id = ? AND w.archived_at IS NULL`,
      )
      .all(pluginId) as { workspace_id: string }[];
    return new Set(rows.map((row) => row.workspace_id));
  }

  byIdentity(pluginId: string, identityKey: string): StoredChannelConnection | undefined {
    const row = this.db
      .prepare("SELECT * FROM channel_connections WHERE plugin_id = ? AND account_key = ?")
      .get(pluginId, identityKey) as ConnectionRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  create(input: {
    workspaceId: WorkspaceId;
    pluginId: string;
    pluginVersion: string;
    method: string;
    botId: BotId;
    config: Readonly<Record<string, unknown>>;
    secretId?: string;
    /** ABI 2 only: the verified identity, unique across the installation (ADR-0047 decision 7). */
    identity?: ChannelIdentity;
    /** ABI 2, a `link` method: stored under a pending key until the plugin claims it. */
    pendingIdentity?: boolean;
    multipleConnections?: boolean;
  }): StoredChannelConnection {
    const abi2 = input.identity !== undefined || input.pendingIdentity === true;
    const multiple = abi2 && input.multipleConnections === true;
    if (!multiple && this.forPluginAll(input.workspaceId, input.pluginId).length > 0) {
      throw new DeskmatesError(
        "invalid_transition",
        "disconnect the existing channel before changing its method",
        {
          pluginId: input.pluginId,
        },
      );
    }
    if (input.identity && this.byIdentity(input.pluginId, input.identity.identityKey))
      throw identityInUse(input.pluginId);
    const id = newId("chn");
    const at = nowIso();
    const accountKey =
      input.identity?.identityKey ??
      (input.pendingIdentity ? channelPendingIdentityKey(input.pluginId, id) : null);
    try {
      this.db
        .prepare(
          `INSERT INTO channel_connections
            (id, workspace_id, plugin_id, plugin_version, api_version, method, bot_id, config_json,
             secret_id, phase, account_key, account_label, multiple_connections, created_at,
             updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'connecting', ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.workspaceId,
          input.pluginId,
          input.pluginVersion,
          abi2 ? 2 : 1,
          input.method,
          input.botId,
          JSON.stringify(input.config),
          input.secretId ?? null,
          accountKey,
          input.identity?.label ?? null,
          multiple ? 1 : 0,
          at,
          at,
        );
    } catch (error) {
      // A concurrent connect of the same identity or single-connection plugin lost the race.
      if (isUniqueViolation(error))
        throw input.identity
          ? identityInUse(input.pluginId)
          : new DeskmatesError("invalid_transition", "the channel is already connected", {
              pluginId: input.pluginId,
            });
      throw error;
    }
    return this.get(id) as StoredChannelConnection;
  }

  status(id: string, status: ChannelConnectionStatus): StoredChannelConnection {
    this.db
      .prepare(
        `UPDATE channel_connections SET phase = ?, message = ?, account = ?, details_json = ?,
           updated_at = ? WHERE id = ?`,
      )
      .run(
        status.phase,
        status.message ?? null,
        status.account ?? null,
        JSON.stringify(status.details ?? {}),
        nowIso(),
        id,
      );
    const row = this.get(id);
    if (!row) throw new DeskmatesError("not_found", `channel connection ${id} not found`);
    return row;
  }

  /**
   * The rebind fence (ADR-0047 decision 8): the new Bot and the next binding generation in one
   * statement, so every host call of the old generation is refused from here on.
   */
  rebind(id: string, botId: BotId, fromGeneration: number): StoredChannelConnection {
    const changed = this.db
      .prepare(
        `UPDATE channel_connections
            SET bot_id = ?, binding_generation = binding_generation + 1, updated_at = ?
          WHERE id = ? AND binding_generation = ?`,
      )
      .run(botId, nowIso(), id, fromGeneration).changes;
    if (changed === 0)
      throw new DeskmatesError("invalid_transition", "the connection changed meanwhile; reload");
    return this.get(id) as StoredChannelConnection;
  }

  /** A relink: the new secret record and the next credential generation; the binding stays. */
  relink(id: string, secretId: string | undefined): StoredChannelConnection {
    this.db
      .prepare(
        `UPDATE channel_connections
            SET secret_id = ?, credential_generation = credential_generation + 1, updated_at = ?
          WHERE id = ?`,
      )
      .run(secretId ?? null, nowIso(), id);
    return this.get(id) as StoredChannelConnection;
  }

  /**
   * A `link` connection's identity, named by its plugin (ADR-0047 amendment 1): stored over the
   * pending key, refused when another connection holds it or when the connection already has a
   * different one. Claiming the stored identity again only refreshes its label.
   */
  claimIdentity(id: string, pluginId: string, identity: ChannelIdentity): StoredChannelConnection {
    const current = this.get(id);
    if (!current) throw new DeskmatesError("not_found", "channel connection not found");
    if (current.identityKey === identity.identityKey) {
      if (current.identityLabel !== identity.label)
        this.db
          .prepare("UPDATE channel_connections SET account_label = ?, updated_at = ? WHERE id = ?")
          .run(identity.label, nowIso(), id);
      return this.get(id) as StoredChannelConnection;
    }
    if (!current.identityPending)
      throw new DeskmatesError(
        "channel_identity_mismatch",
        "This account differs from the one connected here. Disconnect and connect it as a new connection.",
        { connectionId: id },
      );
    const holder = this.byIdentity(pluginId, identity.identityKey);
    if (holder && holder.id !== id) throw identityInUse(pluginId);
    try {
      this.db
        .prepare(
          `UPDATE channel_connections SET account_key = ?, account_label = ?, updated_at = ?
            WHERE id = ? AND account_key = ?`,
        )
        .run(identity.identityKey, identity.label, nowIso(), id, current.identityKey ?? null);
    } catch (error) {
      if (isUniqueViolation(error)) throw identityInUse(pluginId);
      throw error;
    }
    return this.claimIdentity(id, pluginId, identity);
  }

  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM channel_connections WHERE id = ?").run(id).changes > 0;
  }
}
