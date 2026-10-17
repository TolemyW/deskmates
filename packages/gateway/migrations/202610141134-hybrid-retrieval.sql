-- ADR-0041: chunk vectors for Knowledge documents and learned memory, and one row per embedding
-- or rerank call. Empty and unread unless EMBEDDING_URL / RERANK_URL are configured.

-- Decision 3: one L2-normalised little-endian float32 vector per chunk and model. No chunk text is
-- stored; it is recomputed from the current body.
CREATE TABLE knowledge_chunk_vectors (
  document_id  TEXT NOT NULL REFERENCES knowledge_docs(id) ON DELETE CASCADE,
  model        TEXT NOT NULL CHECK (length(model) > 0),
  chunk        INTEGER NOT NULL CHECK (chunk >= 0),
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  dimensions   INTEGER NOT NULL CHECK (dimensions > 0),
  vector       BLOB NOT NULL CHECK (length(vector) = dimensions * 4),
  created_at   TEXT NOT NULL,
  PRIMARY KEY (document_id, model, chunk)
);
CREATE INDEX knowledge_chunk_vectors_scan ON knowledge_chunk_vectors(tenant_id, model);

CREATE TABLE memory_chunk_vectors (
  entry_id      TEXT NOT NULL,
  model         TEXT NOT NULL CHECK (length(model) > 0),
  chunk         INTEGER NOT NULL CHECK (chunk >= 0),
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  dimensions    INTEGER NOT NULL CHECK (dimensions > 0),
  vector        BLOB NOT NULL CHECK (length(vector) = dimensions * 4),
  created_at    TEXT NOT NULL,
  PRIMARY KEY (entry_id, model, chunk),
  FOREIGN KEY (workspace_id, entry_id) REFERENCES memory_entries(workspace_id, id) ON DELETE CASCADE
);
-- The scan reads one workspace (decision 5); the same index serves the composite foreign key.
CREATE INDEX memory_chunk_vectors_scan ON memory_chunk_vectors(workspace_id, entry_id);

-- A vector never outlives the text it came from: a changed document, a changed or forgotten
-- entry, and an entry distilled into an episode lose their vectors in the same statement.
CREATE TRIGGER knowledge_chunk_vectors_stale AFTER UPDATE OF title, body ON knowledge_docs
WHEN old.title IS NOT new.title OR old.body IS NOT new.body
BEGIN
  DELETE FROM knowledge_chunk_vectors WHERE document_id = new.id;
END;

CREATE TRIGGER memory_chunk_vectors_stale AFTER UPDATE OF body, tombstoned, episode_id ON memory_entries
WHEN old.body IS NOT new.body OR new.tombstoned = 1 OR new.episode_id IS NOT NULL
BEGIN
  DELETE FROM memory_chunk_vectors WHERE entry_id = new.id;
END;

-- Decision 8: every embedding or rerank request, ok or not. input_tokens NULL is unknown.
CREATE TABLE retrieval_calls (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  run_id        TEXT REFERENCES runs(id) ON DELETE SET NULL,
  corpus        TEXT NOT NULL CHECK (corpus IN ('knowledge', 'memory')),
  purpose       TEXT NOT NULL CHECK (purpose IN ('index', 'query')),
  service       TEXT NOT NULL CHECK (service IN ('embedding', 'rerank')),
  model         TEXT NOT NULL,
  inputs        INTEGER NOT NULL CHECK (inputs >= 0),
  input_tokens  INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  duration_ms   INTEGER NOT NULL CHECK (duration_ms >= 0),
  outcome       TEXT NOT NULL CHECK (outcome IN ('ok', 'error', 'timeout')),
  created_at    TEXT NOT NULL
);
CREATE INDEX retrieval_calls_tenant ON retrieval_calls(tenant_id, created_at);
CREATE INDEX retrieval_calls_run ON retrieval_calls(run_id);
