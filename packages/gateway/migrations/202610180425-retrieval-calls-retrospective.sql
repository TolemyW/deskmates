-- deskmates:foreign-keys-off
-- ADR-0046 amendment 2 decision 24: the failure retrospective's embedding requests are recorded in
-- `retrieval_calls` like every other ADR-0041 call, under a third corpus, `retrospective`. SQLite
-- cannot widen a CHECK in place, so the table is rebuilt with the same columns, keys and indexes
-- and one more allowed corpus. Rows are copied unchanged. `task`, added by the task-kinds migration
-- just before this one (ADR-0021 amendment 4), stays allowed.
CREATE TABLE retrieval_calls_new (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  run_id        TEXT REFERENCES runs(id) ON DELETE SET NULL,
  corpus        TEXT NOT NULL CHECK (corpus IN ('knowledge', 'memory', 'retrospective', 'task')),
  purpose       TEXT NOT NULL CHECK (purpose IN ('index', 'query')),
  service       TEXT NOT NULL CHECK (service IN ('embedding', 'rerank')),
  model         TEXT NOT NULL,
  inputs        INTEGER NOT NULL CHECK (inputs >= 0),
  input_tokens  INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  duration_ms   INTEGER NOT NULL CHECK (duration_ms >= 0),
  outcome       TEXT NOT NULL CHECK (outcome IN ('ok', 'error', 'timeout')),
  created_at    TEXT NOT NULL
);
INSERT INTO retrieval_calls_new SELECT * FROM retrieval_calls;
DROP TABLE retrieval_calls;
ALTER TABLE retrieval_calls_new RENAME TO retrieval_calls;
CREATE INDEX retrieval_calls_tenant ON retrieval_calls(tenant_id, created_at);
CREATE INDEX retrieval_calls_run ON retrieval_calls(run_id);
