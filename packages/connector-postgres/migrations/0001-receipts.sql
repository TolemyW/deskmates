-- The connector's own receipt store. Append-only: a status change is a new row in
-- receipt_versions, a statement outcome is a new row in statement_results, and triggers refuse
-- every UPDATE and DELETE so no code path can rewrite history.

CREATE TABLE receipts (
  receipt_id      TEXT PRIMARY KEY,
  content_hash    TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  validation_id   TEXT NOT NULL,
  batch_id        TEXT NOT NULL,
  -- The validated batch exactly as it will run; an accepted receipt can run after a restart.
  batch_json      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  UNIQUE (content_hash, idempotency_key)
);

CREATE TABLE receipt_versions (
  receipt_id  TEXT NOT NULL REFERENCES receipts (receipt_id),
  version     INTEGER NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('accepted', 'running', 'succeeded', 'failed', 'rejected')),
  detail      TEXT NOT NULL,
  result_ref  TEXT,
  -- Per-case, per-statement results; set on terminal versions.
  cases_json  TEXT,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (receipt_id, version)
);

-- Outcomes as they happen, so a restart during a run knows what was already sent.
-- statement_index -1 records a case whose connection could not be opened.
CREATE TABLE statement_results (
  receipt_id      TEXT NOT NULL REFERENCES receipts (receipt_id),
  case_index      INTEGER NOT NULL,
  statement_index INTEGER NOT NULL,
  result_json     TEXT NOT NULL,
  recorded_at     TEXT NOT NULL,
  PRIMARY KEY (receipt_id, case_index, statement_index)
);

CREATE TRIGGER receipts_no_update BEFORE UPDATE ON receipts
BEGIN SELECT RAISE(ABORT, 'receipts are append-only'); END;
CREATE TRIGGER receipts_no_delete BEFORE DELETE ON receipts
BEGIN SELECT RAISE(ABORT, 'receipts are append-only'); END;
CREATE TRIGGER receipt_versions_no_update BEFORE UPDATE ON receipt_versions
BEGIN SELECT RAISE(ABORT, 'receipt versions are append-only'); END;
CREATE TRIGGER receipt_versions_no_delete BEFORE DELETE ON receipt_versions
BEGIN SELECT RAISE(ABORT, 'receipt versions are append-only'); END;
CREATE TRIGGER statement_results_no_update BEFORE UPDATE ON statement_results
BEGIN SELECT RAISE(ABORT, 'statement results are append-only'); END;
CREATE TRIGGER statement_results_no_delete BEFORE DELETE ON statement_results
BEGIN SELECT RAISE(ABORT, 'statement results are append-only'); END;
