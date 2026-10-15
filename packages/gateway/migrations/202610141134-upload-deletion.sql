-- ADR-0014 amendment A5 decision 43 (issue #52): any Admin may delete a completed upload's file.
-- The row stays as provenance; `deleted_at` and `deleted_by` (an actor label) record the deletion,
-- and Files, the quota and message attachments stop counting it.
ALTER TABLE workspace_uploads ADD COLUMN deleted_at TEXT;
ALTER TABLE workspace_uploads ADD COLUMN deleted_by TEXT;

INSERT INTO audit_actions (action) VALUES ('file.delete');
