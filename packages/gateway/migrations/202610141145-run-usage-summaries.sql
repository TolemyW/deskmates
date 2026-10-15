-- Stored per-run usage summaries (ADR-0032 amendment 1, issue #113). The Costs page groups these
-- with SQL instead of rebuilding every run's receipt per request. Written when an attempt ends;
-- the triggers below delete a run's summary whenever one of its inputs changes, and the next
-- reader recomputes it. Existing runs are backfilled lazily by the first reader that needs them:
-- the receipt projection is code, not SQL. A price-table edit deletes nothing (history is not
-- re-priced).
CREATE TABLE run_usage_summaries (
  run_id            TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  coverage          TEXT NOT NULL CHECK (coverage IN ('complete', 'partial', 'unknown', 'not_started')),
  estimate_version  TEXT NOT NULL,
  computed_at       TEXT NOT NULL,
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs(workspace_id, id) ON DELETE CASCADE
);
-- Cascades from a deleted workspace or run.
CREATE INDEX run_usage_summaries_workspace_run ON run_usage_summaries(workspace_id, run_id);

-- One row per run and model. Counts are receipt rows; `observed_unpriced_count` are unpriced
-- rows that are observations, which a reader does not count as unpriced while the run is in
-- flight. A null cost means no row of the model was priced (or estimated), never zero.
CREATE TABLE run_usage_summary_models (
  run_id                   TEXT NOT NULL REFERENCES run_usage_summaries(run_id) ON DELETE CASCADE,
  workspace_id             TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  model                    TEXT NOT NULL,
  usage_count              INTEGER NOT NULL CHECK (usage_count >= 0),
  input_tokens             INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens            INTEGER NOT NULL CHECK (output_tokens >= 0),
  cache_read_tokens        INTEGER NOT NULL CHECK (cache_read_tokens >= 0),
  cache_create_tokens      INTEGER NOT NULL CHECK (cache_create_tokens >= 0),
  priced_usage_count       INTEGER NOT NULL CHECK (priced_usage_count >= 0),
  unpriced_usage_count     INTEGER NOT NULL CHECK (unpriced_usage_count >= 0),
  observed_unpriced_count  INTEGER NOT NULL CHECK (observed_unpriced_count >= 0),
  estimated_usage_count    INTEGER NOT NULL CHECK (estimated_usage_count >= 0),
  unestimated_usage_count  INTEGER NOT NULL CHECK (unestimated_usage_count >= 0),
  unmeasured_usage_count   INTEGER NOT NULL CHECK (unmeasured_usage_count >= 0),
  known_cost_usd           REAL,
  estimated_cost_usd       REAL,
  attribution_uncertain    INTEGER NOT NULL CHECK (attribution_uncertain IN (0, 1)),
  PRIMARY KEY (run_id, model)
);
-- Cascades from a deleted workspace.
CREATE INDEX run_usage_summary_models_workspace ON run_usage_summary_models(workspace_id);

-- Invalidation: any write to a summary's inputs deletes it (decision 12).
CREATE TRIGGER run_usage_summary_stale_usage_insert AFTER INSERT ON run_usage
BEGIN DELETE FROM run_usage_summaries WHERE run_id = NEW.run_id; END;

CREATE TRIGGER run_usage_summary_stale_usage_update AFTER UPDATE ON run_usage
BEGIN DELETE FROM run_usage_summaries WHERE run_id IN (OLD.run_id, NEW.run_id); END;

CREATE TRIGGER run_usage_summary_stale_usage_delete AFTER DELETE ON run_usage
BEGIN DELETE FROM run_usage_summaries WHERE run_id = OLD.run_id; END;

CREATE TRIGGER run_usage_summary_stale_request_insert AFTER INSERT ON model_requests
BEGIN DELETE FROM run_usage_summaries WHERE run_id = NEW.run_id; END;

CREATE TRIGGER run_usage_summary_stale_request_update AFTER UPDATE ON model_requests
BEGIN DELETE FROM run_usage_summaries WHERE run_id IN (OLD.run_id, NEW.run_id); END;

CREATE TRIGGER run_usage_summary_stale_event AFTER INSERT ON run_events
WHEN NEW.kind = 'turn_usage'
  OR (NEW.kind = 'log' AND json_extract(NEW.payload_json, '$.source')
        IN ('sdk', 'usage_final', 'usage_session_baseline'))
BEGIN DELETE FROM run_usage_summaries WHERE run_id = NEW.run_id; END;

CREATE TRIGGER run_usage_summary_stale_attempt AFTER UPDATE OF attempt, started_at ON runs
WHEN NEW.attempt IS NOT OLD.attempt OR NEW.started_at IS NOT OLD.started_at
BEGIN DELETE FROM run_usage_summaries WHERE run_id = NEW.id; END;
