-- ADR-0011 amendment 2 (issue #85): newer facts replace older ones silently. A note has a fact key
-- and an effective time; one current note per (store, fact key); every source of a note is kept;
-- every supersession leaves a receipt; every memory version a run was given is recorded.

ALTER TABLE memory_entries ADD COLUMN fact_key TEXT;
-- The time the note orders by (A9). NULL marks a row written before A7: the Gateway gives it a
-- key and an effective time the first time its workspace's memory is written or pinned.
ALTER TABLE memory_entries ADD COLUMN effective_at TEXT;
ALTER TABLE memory_entries ADD COLUMN effective_basis TEXT NOT NULL DEFAULT 'ingest'
  CHECK (effective_basis IN ('source', 'run', 'human', 'ingest'));

-- Children below keep their entry's workspace by composite key (ADR-0031 decision 6).
CREATE UNIQUE INDEX memory_entries_workspace_id ON memory_entries(workspace_id, id);

-- A8: at most one current note per store and fact key. `bot_id` and `thread_id` name the store of
-- bot and task notes; COALESCE because SQLite treats NULLs as distinct in a unique index.
CREATE UNIQUE INDEX memory_entries_current_fact ON memory_entries(
  workspace_id, scope, COALESCE(bot_id, ''), COALESCE(thread_id, ''), fact_key
) WHERE fact_key IS NOT NULL AND kind = 'note' AND tombstoned = 0 AND invalid_at IS NULL
    AND episode_id IS NULL;

-- Rows written before A7 (the backfill's query shape).
CREATE INDEX memory_entries_unkeyed ON memory_entries(workspace_id) WHERE effective_at IS NULL;

-- A10: every source of a note. The first row is the write that created it; later rows are
-- equivalent copies consolidated into it. (source run, ordinal) makes a learned write idempotent.
CREATE TABLE memory_entry_sources (
  seq              INTEGER PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entry_id         TEXT NOT NULL,
  source_run_id    TEXT REFERENCES runs(id) ON DELETE SET NULL,
  ordinal          INTEGER CHECK (ordinal IS NULL OR ordinal >= 0),
  source_kind      TEXT NOT NULL
                   CHECK (source_kind IN ('human', 'bot_self', 'other_bot', 'tool', 'page', 'webhook')),
  trust            TEXT NOT NULL CHECK (trust IN ('trusted', 'untrusted')),
  effective_at     TEXT NOT NULL,
  effective_basis  TEXT NOT NULL CHECK (effective_basis IN ('source', 'run', 'human', 'ingest')),
  recorded_at      TEXT NOT NULL,
  FOREIGN KEY (workspace_id, entry_id) REFERENCES memory_entries(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX memory_entry_sources_entry ON memory_entry_sources(workspace_id, entry_id, seq);
-- NULLs are distinct in a unique index: a human source (no run, no ordinal) never collides.
CREATE UNIQUE INDEX memory_entry_sources_item ON memory_entry_sources(source_run_id, ordinal);

-- A9 and A12: why a note stopped being current, and what took its place.
CREATE TABLE memory_supersessions (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entry_id             TEXT NOT NULL,
  winner_id            TEXT NOT NULL,
  fact_key             TEXT NOT NULL,
  reason               TEXT NOT NULL CHECK (reason IN (
                         'backfill', 'equivalent_higher_trust', 'equivalent_lower_trust',
                         'newer_effective_time', 'older_arrival', 'tie_entry_id',
                         'tie_later_ingestion', 'undo_restore')),
  entry_effective_at   TEXT NOT NULL,
  winner_effective_at  TEXT NOT NULL,
  decided_by           TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  FOREIGN KEY (workspace_id, entry_id) REFERENCES memory_entries(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, winner_id) REFERENCES memory_entries(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX memory_supersessions_entry ON memory_supersessions(workspace_id, entry_id);
CREATE INDEX memory_supersessions_winner ON memory_supersessions(workspace_id, winner_id);

-- A13: every (entry, version) a run's model context received, and how.
CREATE TABLE run_memory_versions (
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id        TEXT NOT NULL,
  entry_id      TEXT NOT NULL,
  version       INTEGER NOT NULL CHECK (version >= 1),
  via           TEXT NOT NULL CHECK (via IN ('pinned', 'search')),
  supplied_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, run_id, entry_id, version, via),
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, entry_id) REFERENCES memory_entries(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX run_memory_versions_entry ON run_memory_versions(workspace_id, entry_id);
