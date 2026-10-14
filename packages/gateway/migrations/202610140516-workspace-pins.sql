-- ADR-0034 decision 6: a person's own workspace pins, and the index the directory's running-work
-- count reads (decision 5). A pin is a personal preference, not workspace configuration.
CREATE TABLE workspace_pins (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  pinned_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, workspace_id)
);
CREATE INDEX workspace_pins_workspace ON workspace_pins(workspace_id);

CREATE INDEX runs_workspace_status ON runs(workspace_id, status);
