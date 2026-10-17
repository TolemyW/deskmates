-- Workspace limit switches (ADR-0005 amendment 5 decisions 37, 39 and 40, owner 2026-10-14).
-- A row is a switch the workspace turned on; no row means off, and turning a switch off deletes
-- its row. `requireBudgetForOff` makes `off` limits need a monetary limit again; `volumeBreaker`
-- arms the loop breaker's 300-message volume rule. Changes are audited as `workspace.limits_set`
-- with the limits.
CREATE TABLE workspace_limit_switches (
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  switch_key    TEXT NOT NULL CHECK (switch_key IN ('requireBudgetForOff', 'volumeBreaker')),
  updated_by    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (workspace_id, switch_key)
);
