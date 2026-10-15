-- Run audit (issue #11, ADR-0042). `run_marks`: an operator's verdict on one run with an optional
-- note; while it stands, consolidation skips the run's learned items. `run_retention_prunes`: the
-- record a run keeps after retention removed its events, usage rows and model requests, so the
-- run drawer and the Costs page can say so instead of showing an empty ledger.

CREATE TABLE run_marks (
  run_id        TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  verdict       TEXT NOT NULL CHECK (verdict IN ('wrong')),
  note          TEXT CHECK (note IS NULL OR length(note) <= 2000),
  marked_by     TEXT NOT NULL,
  marked_at     TEXT NOT NULL,
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs(workspace_id, id) ON DELETE CASCADE
);
-- Cascades from a deleted workspace or run.
CREATE INDEX run_marks_workspace_run ON run_marks(workspace_id, run_id);

CREATE TABLE run_retention_prunes (
  run_id          TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  pruned_at       TEXT NOT NULL,
  retention_days  INTEGER NOT NULL CHECK (retention_days > 0),
  event_count     INTEGER NOT NULL CHECK (event_count >= 0),
  usage_count     INTEGER NOT NULL CHECK (usage_count >= 0),
  request_count   INTEGER NOT NULL CHECK (request_count >= 0),
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs(workspace_id, id) ON DELETE CASCADE
);
-- Cascades from a deleted workspace or run.
CREATE INDEX run_retention_prunes_workspace_run ON run_retention_prunes(workspace_id, run_id);
