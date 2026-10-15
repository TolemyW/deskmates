-- ADR-0002 amendment 3, A7 and A8 (issue #54): an unattended approval request expires to deny
-- after the workspace's `approval_expiry_minutes` (default 15, a proposed guess), and one reminder
-- reaches humans before that; `reminded_at` records it so a sweep never sends a second one.
ALTER TABLE workspaces ADD COLUMN approval_expiry_minutes INTEGER NOT NULL DEFAULT 15
  CHECK (approval_expiry_minutes BETWEEN 1 AND 1440);

ALTER TABLE approvals ADD COLUMN reminded_at TEXT;

INSERT INTO audit_actions (action) VALUES ('workspace.approval_expiry_set');
