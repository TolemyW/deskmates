-- Workspace execution limits (ADR-0005 amendment 5, ADR-0016 amendment 2). One row per stored
-- setting; no row means the key inherits its default. `value` NULL is `off`, which the Gateway
-- accepts only while the workspace has a monetary limit (ADR-0032).
CREATE TABLE workspace_limits (
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  limit_key     TEXT NOT NULL CHECK (limit_key IN (
                  'continuationLimit', 'continuationWindowHours', 'maxTurns',
                  'relayCountMax', 'turnBudget')),
  value         INTEGER CHECK (value IS NULL OR value >= 0),
  updated_by    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (workspace_id, limit_key)
);

INSERT INTO audit_actions (action) VALUES ('workspace.limits_set');
