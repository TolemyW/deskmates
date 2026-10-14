import {
  type BotId,
  type ChannelConnection,
  type ChannelConnectionStatus,
  DeskmatesError,
  type WorkspaceId,
} from "@deskmates/contracts";
import { newId, nowIso, parseJson } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";

interface ConnectionRow {
  id: string;
  workspace_id: string;
  plugin_id: string;
  plugin_version: string;
  method: string;
  bot_id: string;
  config_json: string;
  secret_id: string | null;
  phase: string;
  message: string | null;
  account: string | null;
  details_json: string;
  created_at: string;
  updated_at: string;
}

export interface StoredChannelConnection extends ChannelConnection {
  secretId?: string;
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
    ...(row.secret_id ? { secretId: row.secret_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function publicChannelConnection(connection: StoredChannelConnection): ChannelConnection {
  const { secretId: _secretId, ...safe } = connection;
  return safe;
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

  forPlugin(workspaceId: WorkspaceId, pluginId: string): StoredChannelConnection | undefined {
    const row = this.db
      .prepare("SELECT * FROM channel_connections WHERE workspace_id = ? AND plugin_id = ?")
      .get(workspaceId, pluginId) as ConnectionRow | undefined;
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
  }): StoredChannelConnection {
    if (this.forPlugin(input.workspaceId, input.pluginId)) {
      throw new DeskmatesError(
        "invalid_transition",
        "disconnect the existing channel before changing its method",
        {
          pluginId: input.pluginId,
        },
      );
    }
    const id = newId("chn");
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO channel_connections
          (id, workspace_id, plugin_id, plugin_version, method, bot_id, config_json, secret_id,
           phase, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'connecting', ?, ?)`,
      )
      .run(
        id,
        input.workspaceId,
        input.pluginId,
        input.pluginVersion,
        input.method,
        input.botId,
        JSON.stringify(input.config),
        input.secretId ?? null,
        at,
        at,
      );
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

  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM channel_connections WHERE id = ?").run(id).changes > 0;
  }
}
