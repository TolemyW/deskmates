-- Workspace uploads (ADR-0014 amendment A5): one row per upload session. The Gateway stores no
-- file bytes; the container holds them under /work/uploads/ (decisions 29 and 33).

CREATE TABLE workspace_uploads (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- The uploader's actor label; provenance that survives the person's removal (decision 35).
  uploader          TEXT NOT NULL,
  uploader_user_id  TEXT,
  name              TEXT NOT NULL,
  label             TEXT NOT NULL,
  size_bytes        INTEGER NOT NULL CHECK (size_bytes >= 0),
  received_bytes    INTEGER NOT NULL DEFAULT 0
                      CHECK (received_bytes >= 0 AND received_bytes <= size_bytes),
  state             TEXT NOT NULL
                      CHECK (state IN ('receiving', 'completed', 'cancelled', 'expired')),
  path              TEXT,
  sha256            TEXT,
  idempotency_key   TEXT,
  failure           TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  completed_at      TEXT,
  CHECK ((state = 'completed') = (path IS NOT NULL AND sha256 IS NOT NULL AND completed_at IS NOT NULL))
);
-- Decision 31: one session per client idempotency key in a workspace.
CREATE UNIQUE INDEX workspace_uploads_idempotency
  ON workspace_uploads(workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
-- The Files source (completed, newest first), the quota sum and the idle-expiry sweep.
CREATE INDEX workspace_uploads_state ON workspace_uploads(workspace_id, state, updated_at);

INSERT INTO audit_actions (action) VALUES ('file.upload');
