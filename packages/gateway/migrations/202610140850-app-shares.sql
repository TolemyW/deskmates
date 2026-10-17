-- Published workspace apps (ADR-0035). One row per publication; a revoked row stays for the
-- record and its port may be published again as a new row. The id's hex part is the app's host
-- label, so it is unique by construction. Bot and run are kept as plain ids: a publication
-- outlives the run, and a purged bot must not delete what the audit log refers to.
CREATE TABLE app_shares (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  port          INTEGER NOT NULL CHECK (port BETWEEN 1024 AND 65535
                  AND port NOT BETWEEN 6080 AND 6086),
  label         TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  bot_id        TEXT,
  run_id        TEXT,
  created_at    TEXT NOT NULL,
  revoked_at    TEXT,
  revoked_by    TEXT,
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);

-- The workspace list, newest first, and the one active publication per port.
CREATE INDEX app_shares_workspace ON app_shares (workspace_id, created_at DESC, id);
CREATE UNIQUE INDEX app_shares_active_port ON app_shares (workspace_id, port)
  WHERE revoked_at IS NULL;

INSERT INTO audit_actions (action) VALUES ('app_share.publish'), ('app_share.revoke');
