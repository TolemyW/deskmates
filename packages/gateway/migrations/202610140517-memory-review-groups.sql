-- ADR-0011 amendment 3 (issues #85 and #113 slice K2): review groups of gated items, batch
-- dispositions with undo, topic tags of entries, and the indexes of the paged memory lists.

-- A17: the review group of a gated item. NULL marks a row gated before this amendment; the
-- Gateway computes it the first time its workspace's queue is read.
ALTER TABLE memory_suggestions ADD COLUMN group_key TEXT;
CREATE INDEX memory_suggestions_group
  ON memory_suggestions(workspace_id, status, group_key, created_at, id);
CREATE INDEX memory_suggestions_ungrouped ON memory_suggestions(workspace_id) WHERE group_key IS NULL;

-- A20: the topic tag of an entry (key lower-cased, label as written). `topic_set` = 0 marks a row
-- written before this amendment; a body without a topic has `topic_set` = 1 and a NULL key.
ALTER TABLE memory_entries ADD COLUMN topic TEXT;
ALTER TABLE memory_entries ADD COLUMN topic_label TEXT;
ALTER TABLE memory_entries ADD COLUMN topic_set INTEGER NOT NULL DEFAULT 0 CHECK (topic_set IN (0, 1));
CREATE INDEX memory_entries_topic ON memory_entries(workspace_id, tombstoned, topic);
CREATE INDEX memory_entries_untopiced ON memory_entries(workspace_id) WHERE topic_set = 0;

-- A23: the entry list's order (`observed_at DESC, id DESC`) uses the baseline's
-- `memory_entries_workspace_list`.

-- A18, A19: one row per committed batch disposition, one per item it decided.
CREATE TABLE memory_review_batches (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  group_key      TEXT NOT NULL,
  decision       TEXT NOT NULL CHECK (decision IN ('reject', 'merge')),
  -- The preview token it was committed with: a repeated commit returns this batch.
  token          TEXT NOT NULL,
  entry_id       TEXT,
  created_entry  INTEGER NOT NULL DEFAULT 0 CHECK (created_entry IN (0, 1)),
  entry_version  INTEGER,
  decided_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  undone_by      TEXT,
  undone_at      TEXT,
  UNIQUE (workspace_id, token),
  CHECK ((decision = 'merge') = (entry_id IS NOT NULL)),
  CHECK ((undone_by IS NULL) = (undone_at IS NULL)),
  FOREIGN KEY (workspace_id, entry_id) REFERENCES memory_entries(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX memory_review_batches_workspace ON memory_review_batches(workspace_id, created_at, id);
CREATE INDEX memory_review_batches_entry ON memory_review_batches(workspace_id, entry_id);

CREATE TABLE memory_review_batch_items (
  batch_id       TEXT NOT NULL REFERENCES memory_review_batches(id) ON DELETE CASCADE,
  suggestion_id  TEXT NOT NULL REFERENCES memory_suggestions(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (batch_id, suggestion_id)
);
CREATE INDEX memory_review_batch_items_suggestion ON memory_review_batch_items(suggestion_id);

INSERT INTO audit_actions (action) VALUES ('memory.review_batch'), ('memory.review_batch_undo');
