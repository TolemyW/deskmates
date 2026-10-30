-- ADR-0002 amendment 3, A5 (owner-signed 2026-10-17): an operator may override one tool's tier
-- in one workspace. No row is the default: every tool keeps the sidecar's curated tier. A row is
-- an operator action, recorded with who set it; bots have no route that writes here.
CREATE TABLE workspace_tool_tiers (
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  tool_name     TEXT NOT NULL,
  risk_level    TEXT NOT NULL CHECK (risk_level IN ('L0', 'L1', 'L2')),
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (workspace_id, tool_name)
);

INSERT INTO audit_actions (action) VALUES ('workspace.tool_tier_set');
