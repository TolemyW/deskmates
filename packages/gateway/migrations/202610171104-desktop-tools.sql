-- ADR-0048 decision 1 (owner rulings of 2026-10-17, issue #7): opt-in native desktop tools. A row
-- in `workspace_desktop_tools` means an Owner or Admin enabled them on a workspace whose image
-- declared the capability, with the versions it declared then; no row means off. A row in
-- `bot_desktop_tools` means that bot has them, which counts only while its workspace has a row.
-- Runs freeze what these say in `runs.config_json.desktopTools` when attempt 1 starts.
CREATE TABLE workspace_desktop_tools (
  workspace_id  TEXT NOT NULL PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  mode          TEXT NOT NULL CHECK (mode IN ('lcu-v1')),
  lcu_version   TEXT,
  app_version   TEXT,
  updated_by    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE bot_desktop_tools (
  bot_id        TEXT NOT NULL PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  updated_by    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX bot_desktop_tools_workspace ON bot_desktop_tools (workspace_id);

INSERT INTO audit_actions (action) VALUES ('workspace.desktop_tools_set');
