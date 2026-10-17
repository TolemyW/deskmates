-- ADR-0002 amendment 6 (issue #54, owner-decided 2026-10-14). D1: the approval mode replaces the
-- automatic-approval boolean; a workspace that had it on is `automatic`, every other existing one
-- `manual`, and a new workspace starts `automatic`.
ALTER TABLE workspaces ADD COLUMN approval_mode TEXT NOT NULL DEFAULT 'automatic'
  CHECK (approval_mode IN ('manual', 'automatic', 'approve_all'));

UPDATE workspaces
   SET approval_mode = CASE WHEN auto_approval = 1 THEN 'automatic' ELSE 'manual' END;

ALTER TABLE workspaces DROP COLUMN auto_approval;

-- D7: the expiry default becomes 60 minutes. A workspace still on the old default of 15 that
-- nobody ever changed (no expiry audit row) moves with it; a deliberate 15 stays.
UPDATE workspaces
   SET approval_expiry_minutes = 60
 WHERE approval_expiry_minutes = 15
   AND NOT EXISTS (
     SELECT 1 FROM audit_events a
      WHERE a.workspace_id = workspaces.id AND a.action = 'workspace.approval_expiry_set'
   );

INSERT INTO audit_actions (action) VALUES ('workspace.approval_mode_set');
