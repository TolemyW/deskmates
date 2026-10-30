-- ADR-0047 decisions 7 to 10 and 13: a channel connection is one verified external identity bound
-- to one Bot, unique across the installation. `UNIQUE (workspace_id, plugin_id)` is replaced by
-- the account-key index and, for plugins without `multipleConnections` (WhatsApp, ABI 1), a partial
-- unique index that keeps one connection per workspace (ADR-0017 amendment 1 P4). SQLite cannot
-- drop a table constraint in place, so the table is rebuilt; nothing references it yet.

CREATE TABLE channel_connections_next (
  id                     TEXT PRIMARY KEY,
  workspace_id           TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plugin_id              TEXT NOT NULL,
  plugin_version         TEXT NOT NULL,
  -- The plugin ABI that owns the connection: 1 plugin-wide host, 2 connection-scoped host.
  api_version            INTEGER NOT NULL DEFAULT 1 CHECK (api_version IN (1, 2)),
  method                 TEXT NOT NULL,
  -- No action: a bot with a live channel is not purged. Checked at statement end, so a
  -- workspace purge that removes both passes.
  bot_id                 TEXT NOT NULL REFERENCES bots(id),
  config_json            TEXT NOT NULL CHECK (json_valid(config_json)),
  secret_id              TEXT REFERENCES secrets(id) ON DELETE SET NULL,
  phase                  TEXT NOT NULL,
  message                TEXT,
  account                TEXT,
  details_json           TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  -- The verified provider account key `<plugin id>:<namespace>:<id>` (decision 6); NULL for
  -- ABI 1. ADR-0004 item 4 keeps the contracts' name for it out of the schema.
  account_key            TEXT,
  account_label          TEXT,
  -- Decision 8: a rebind increments the binding generation, a relink the credential generation.
  binding_generation     INTEGER NOT NULL DEFAULT 1 CHECK (binding_generation >= 1),
  credential_generation  INTEGER NOT NULL DEFAULT 1 CHECK (credential_generation >= 1),
  -- The manifest's `multipleConnections` when the connection was created.
  multiple_connections   INTEGER NOT NULL DEFAULT 0 CHECK (multiple_connections IN (0, 1)),
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  CHECK (api_version = 2 OR account_key IS NULL),
  CHECK (account_key IS NOT NULL OR api_version = 1)
);

INSERT INTO channel_connections_next
  (id, workspace_id, plugin_id, plugin_version, method, bot_id, config_json, secret_id, phase,
   message, account, details_json, created_at, updated_at)
SELECT id, workspace_id, plugin_id, plugin_version, method, bot_id, config_json, secret_id, phase,
       message, account, details_json, created_at, updated_at
  FROM channel_connections;

DROP TABLE channel_connections;
ALTER TABLE channel_connections_next RENAME TO channel_connections;

CREATE UNIQUE INDEX channel_connections_account
  ON channel_connections(plugin_id, account_key) WHERE account_key IS NOT NULL;
CREATE UNIQUE INDEX channel_connections_single
  ON channel_connections(workspace_id, plugin_id) WHERE multiple_connections = 0;
CREATE INDEX channel_connections_workspace_plugin ON channel_connections(workspace_id, plugin_id);
CREATE INDEX channel_connections_plugin ON channel_connections(plugin_id);
CREATE INDEX channel_connections_bot ON channel_connections(bot_id);
CREATE INDEX channel_connections_secret ON channel_connections(secret_id);

-- Decision 10: an ABI-2 channel thread names its connection and binding generation. A
-- disconnect keeps the thread as a read-only mirror and clears the reference.
ALTER TABLE threads ADD COLUMN channel_connection_id TEXT
  REFERENCES channel_connections(id) ON DELETE SET NULL;
ALTER TABLE threads ADD COLUMN binding_generation INTEGER;
CREATE INDEX threads_channel_connection ON threads(channel_connection_id, binding_generation);

-- Decision 13: allow by default; a blocked sender is dropped in both directions.
CREATE TABLE channel_sender_blocks (
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id  TEXT NOT NULL,
  sender_id      TEXT NOT NULL,
  note           TEXT,
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (connection_id, sender_id),
  FOREIGN KEY (workspace_id, connection_id)
    REFERENCES channel_connections(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX channel_sender_blocks_workspace ON channel_sender_blocks(workspace_id, connection_id);

-- Decision 9's send gate: one receipt per relayed message, with the generations it was decided
-- under. `cancelled` is written at a rebind or disconnect fence, `blocked` for a blocked sender.
CREATE TABLE channel_outbound_receipts (
  id                     TEXT PRIMARY KEY,
  workspace_id           TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id              TEXT NOT NULL,
  message_seq            INTEGER NOT NULL,
  -- Kept after a disconnect so the record of what was sent and cancelled survives.
  connection_id          TEXT REFERENCES channel_connections(id) ON DELETE SET NULL,
  binding_generation     INTEGER NOT NULL,
  credential_generation  INTEGER NOT NULL,
  state                  TEXT NOT NULL CHECK (state IN ('sent', 'cancelled', 'blocked')),
  -- The provider's id of the last chunk, and how many chunks were sent.
  provider_message_id    TEXT,
  chunk_count            INTEGER NOT NULL DEFAULT 0,
  reason                 TEXT,
  created_at             TEXT NOT NULL,
  UNIQUE (thread_id, message_seq),
  FOREIGN KEY (workspace_id, thread_id) REFERENCES threads(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX channel_outbound_receipts_workspace ON channel_outbound_receipts(workspace_id, thread_id);
CREATE INDEX channel_outbound_receipts_connection ON channel_outbound_receipts(connection_id, state);

INSERT INTO audit_actions (action) VALUES
  ('channel.rebind'), ('channel.relink'), ('channel.sender_block'), ('channel.sender_unblock');
