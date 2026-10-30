-- ADR-0050 decision 6: a bot's read-only `run_stats` tool is off unless an Owner or Admin turns
-- it on. A row means the bot has it; no row means it has not. Runs freeze what this says in
-- `runs.config_json.runStats` when attempt 1 starts (decision 7).
CREATE TABLE bot_run_stats (
  bot_id        TEXT NOT NULL PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mode          TEXT NOT NULL CHECK (mode IN ('self-v1')),
  updated_by    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX bot_run_stats_workspace ON bot_run_stats (workspace_id);

INSERT INTO audit_actions (action) VALUES ('bot.run_stats_set');
