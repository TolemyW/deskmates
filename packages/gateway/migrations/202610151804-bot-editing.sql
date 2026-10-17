-- ADR-0043 (issue #10): a bot is editable after creation.
--
-- Decision 2: every saved SOUL.md and MEMORY.md body is a numbered version per bot and file.
-- Append-only: a restore inserts a new version with an older body and never rewrites a row. The
-- body's sha256 (what a run records as `canonicalSoulVersion`) is computed by the reader.
CREATE TABLE bot_rule_versions (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  bot_id         TEXT NOT NULL,
  file           TEXT NOT NULL CHECK (file IN ('soul', 'memory')),
  version        INTEGER NOT NULL CHECK (version >= 1),
  body           TEXT NOT NULL,
  restored_from  INTEGER CHECK (restored_from IS NULL OR restored_from >= 1),
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  FOREIGN KEY (workspace_id, bot_id) REFERENCES bots(workspace_id, id) ON DELETE CASCADE,
  UNIQUE (workspace_id, bot_id, file, version)
);

CREATE TRIGGER bot_rule_versions_no_update BEFORE UPDATE ON bot_rule_versions
BEGIN SELECT RAISE(ABORT, 'bot rule versions are append-only'); END;

-- The bodies saved before this migration become version 1.
INSERT INTO bot_rule_versions (workspace_id, bot_id, file, version, body, created_by, created_at)
SELECT workspace_id, id, 'soul', 1, soul_body, 'migration', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM bots WHERE soul_body IS NOT NULL AND soul_body <> '';

INSERT INTO bot_rule_versions (workspace_id, bot_id, file, version, body, created_by, created_at)
SELECT workspace_id, id, 'memory', 1, memory_body, 'migration',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM bots WHERE memory_body IS NOT NULL AND memory_body <> '';

-- ADR-0026 amendment 1: a paused bot is woken by nothing new. `paused_by` is an actor label.
ALTER TABLE bots ADD COLUMN paused_at TEXT;
ALTER TABLE bots ADD COLUMN paused_by TEXT;

-- Decision 6: "Run now" on a cron entry is a run of its own trigger kind.
INSERT INTO run_trigger_kinds (kind) VALUES ('manual');

-- Decision 4 (a diary line delete) and decision 6 (an approval rule edit) are audited.
INSERT INTO audit_actions (action) VALUES ('approval_rule.update'), ('bot.diary_edit');
