-- deskmates:foreign-keys-off
-- ADR-0040 amendment B: text-to-image is a third operation, `image_generation`, recorded in
-- `operation_requests` with unit `image` and no mode. SQLite cannot widen a CHECK in place, so the
-- table is rebuilt with the same columns, keys and indexes and one more allowed operation. Rows are
-- copied unchanged.
CREATE TABLE operation_requests_new (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id           TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  attempt          INTEGER NOT NULL CHECK (attempt >= 1),
  operation        TEXT NOT NULL CHECK (operation IN ('look', 'asr', 'image_generation')),
  mode             TEXT CHECK (mode IS NULL OR mode IN ('ocr', 'describe')),
  model            TEXT NOT NULL,
  endpoint_sha256  TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'refused')),
  error_code       TEXT,
  unit             TEXT NOT NULL CHECK (unit IN ('image', 'page', 'audio_second')),
  quantity         REAL CHECK (quantity IS NULL OR quantity >= 0),
  measured         TEXT NOT NULL CHECK (measured IN ('computed', 'provider', 'unknown')),
  input_bytes      INTEGER NOT NULL CHECK (input_bytes >= 0),
  input_sha256     TEXT,
  input_tokens     INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens    INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  latency_ms       INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  cost_usd         REAL CHECK (cost_usd IS NULL OR cost_usd >= 0),
  created_at       TEXT NOT NULL,
  CHECK ((status = 'succeeded') = (error_code IS NULL)),
  CHECK (status <> 'refused' OR quantity IS NULL)
);
INSERT INTO operation_requests_new SELECT * FROM operation_requests;
DROP TABLE operation_requests;
ALTER TABLE operation_requests_new RENAME TO operation_requests;
CREATE INDEX operation_requests_run ON operation_requests(run_id, created_at);
CREATE INDEX operation_requests_workspace ON operation_requests(workspace_id, created_at);
