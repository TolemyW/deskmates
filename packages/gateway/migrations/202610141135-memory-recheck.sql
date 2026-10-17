-- ADR-0011 amendment 4 as ruled by the owner on 2026-10-14 (issue #85): the model rechecks
-- flagged notes automatically (A28), model organisation runs daily (A30), and both are bounded
-- by per-workspace settings (A34).

-- A28: the latest model verdict on a flag, for the note version it was about.
ALTER TABLE memory_revalidations ADD COLUMN model_verdict TEXT
  CHECK (model_verdict IS NULL OR model_verdict IN ('still_true', 'possibly_stale', 'unclear'));
ALTER TABLE memory_revalidations ADD COLUMN model_reason TEXT;
ALTER TABLE memory_revalidations ADD COLUMN model_checked_at TEXT;
ALTER TABLE memory_revalidations ADD COLUMN model_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL;
ALTER TABLE memory_revalidations ADD COLUMN model_entry_version INTEGER
  CHECK (model_entry_version IS NULL OR model_entry_version >= 1);
CREATE INDEX memory_revalidations_verdict
  ON memory_revalidations(workspace_id, status, model_verdict);
CREATE INDEX memory_revalidations_model_run ON memory_revalidations(model_run_id);

-- A28: one recheck job per model call; at most one pending per workspace. `note_count` of the
-- jobs created in the last 24 hours is what the daily limit bounds.
CREATE TABLE memory_recheck_jobs (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id          TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
  note_count      INTEGER NOT NULL CHECK (note_count >= 1),
  still_true      INTEGER NOT NULL DEFAULT 0 CHECK (still_true >= 0),
  possibly_stale  INTEGER NOT NULL DEFAULT 0 CHECK (possibly_stale >= 0),
  unclear         INTEGER NOT NULL DEFAULT 0 CHECK (unclear >= 0),
  dropped         INTEGER NOT NULL DEFAULT 0 CHECK (dropped >= 0),
  error           TEXT,
  created_at      TEXT NOT NULL,
  finished_at     TEXT,
  CHECK ((status = 'pending') = (finished_at IS NULL))
);
CREATE UNIQUE INDEX memory_recheck_jobs_pending ON memory_recheck_jobs(workspace_id)
  WHERE status = 'pending';
CREATE INDEX memory_recheck_jobs_workspace
  ON memory_recheck_jobs(workspace_id, created_at DESC, id DESC);
CREATE INDEX memory_recheck_jobs_run ON memory_recheck_jobs(run_id);

-- A34: per-workspace maintenance settings; no row means the defaults (200, on).
CREATE TABLE memory_maintenance_settings (
  workspace_id         TEXT NOT NULL PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  recheck_daily_limit  INTEGER NOT NULL DEFAULT 200
                       CHECK (recheck_daily_limit BETWEEN 0 AND 1000),
  organize_daily       INTEGER NOT NULL DEFAULT 1 CHECK (organize_daily IN (0, 1)),
  updated_by           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

INSERT INTO audit_actions (action) VALUES ('memory.maintenance_settings');
