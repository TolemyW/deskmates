-- ADR-0048 amendment 1 (owner answers of 2026-10-17, issue #7). A1: desktop tools are on by default
-- on an image that declares `desktop-lcu-v1`, so a row in `workspace_desktop_tools` or
-- `bot_desktop_tools` is now an explicit choice, on or off, and no row is the default. Every row
-- written before this migration meant "on". A bot of an enabled workspace without a row was off
-- under the earlier rule; it keeps that as an explicit off, so no choice changes silently.
-- A4: the audit action recorded when the Gateway stores a desktop call's network denial.
ALTER TABLE workspace_desktop_tools
  ADD COLUMN is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1));
ALTER TABLE bot_desktop_tools
  ADD COLUMN is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1));

INSERT INTO bot_desktop_tools (bot_id, workspace_id, updated_by, updated_at, is_enabled)
SELECT b.id, b.workspace_id, 'migration:desktop-tools-default-on',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 0
FROM bots b
JOIN workspace_desktop_tools w ON w.workspace_id = b.workspace_id
WHERE NOT EXISTS (SELECT 1 FROM bot_desktop_tools d WHERE d.bot_id = b.id);

INSERT INTO audit_actions (action) VALUES ('egress.desktop_denied');
