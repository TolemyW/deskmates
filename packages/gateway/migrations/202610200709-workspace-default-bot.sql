-- ADR-0051 decision 1: a workspace's default bot. One row per workspace at most, one workspace per
-- bot (a bot belongs to one workspace). Moving the bot to Trash deletes the row in the same
-- transaction; purging it cascades. A workspace without a row has no default bot.
CREATE TABLE workspace_default_bots (
  workspace_id  TEXT NOT NULL PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  bot_id        TEXT NOT NULL UNIQUE REFERENCES bots(id) ON DELETE CASCADE,
  set_by        TEXT NOT NULL,
  set_at        TEXT NOT NULL
);

INSERT INTO audit_actions (action) VALUES ('workspace.default_bot_set');
