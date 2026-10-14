-- ADR-0002 amendment 4 (issue #54): the workspace automatic-approval setting, off for every
-- existing and new workspace, and its audit action (B1).
ALTER TABLE workspaces ADD COLUMN auto_approval INTEGER NOT NULL DEFAULT 0
  CHECK (auto_approval IN (0, 1));

INSERT INTO audit_actions (action) VALUES ('workspace.auto_approval_set');

-- Pending inbox order (#113 surface 23): oldest first with the id tie-breaker.
DROP INDEX IF EXISTS approvals_decision_created;
CREATE INDEX approvals_decision_created ON approvals(decision, created_at, id);
