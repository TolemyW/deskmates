-- ADR-0049 (issue #3 item C2): the egress-governed `web_search` tool.
--
-- Decision 4: a row in `workspace_web_search` is an Owner's or Admin's explicit choice, on or off;
-- no row is the default, which is off until the paired comparison says otherwise (decision 13).
CREATE TABLE workspace_web_search (
  workspace_id  TEXT NOT NULL PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  is_enabled    INTEGER NOT NULL CHECK (is_enabled IN (0, 1)),
  updated_by    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Decision 11: one row per search the proxy forwarded or refused. The query is kept as its hash
-- and length only; no query text, result, URL or credential is stored. Search has no unit price.
CREATE TABLE search_requests (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id           TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  attempt          INTEGER NOT NULL CHECK (attempt >= 1),
  endpoint_sha256  TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'refused')),
  error_code       TEXT,
  query_sha256     TEXT,
  query_chars      INTEGER NOT NULL CHECK (query_chars >= 0),
  is_redacted      INTEGER NOT NULL DEFAULT 0 CHECK (is_redacted IN (0, 1)),
  language         TEXT,
  max_results      INTEGER CHECK (max_results IS NULL OR max_results >= 1),
  result_count     INTEGER CHECK (result_count IS NULL OR result_count >= 0),
  dropped_count    INTEGER CHECK (dropped_count IS NULL OR dropped_count >= 0),
  latency_ms       INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  created_at       TEXT NOT NULL,
  CHECK ((status = 'succeeded') = (error_code IS NULL)),
  CHECK (status = 'succeeded' OR result_count IS NULL)
);
CREATE INDEX search_requests_run ON search_requests (run_id, created_at);
CREATE INDEX search_requests_workspace ON search_requests (workspace_id, created_at);

INSERT INTO audit_actions (action) VALUES ('workspace.web_search_set');
