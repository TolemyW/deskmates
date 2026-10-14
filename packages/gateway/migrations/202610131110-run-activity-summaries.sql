-- Activity summaries (ADR-0033, issue #109): one cached presentation summary per source version
-- of a run, inserted with its job so a second trigger finds it and queues nothing. A source that
-- already fits the bound has no row: it is shown verbatim.

CREATE TABLE run_activity_summaries (
  run_id          TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  source_version  TEXT NOT NULL,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status          TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
  text            TEXT,
  summary_run_id  TEXT REFERENCES runs(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (run_id, source_version)
);
CREATE INDEX run_activity_summaries_workspace ON run_activity_summaries(workspace_id, created_at);
CREATE INDEX run_activity_summaries_job ON run_activity_summaries(summary_run_id);
