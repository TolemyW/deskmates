-- ADR-0023 amendment 1: model capability probes (issue #87) and SOUL proposals (issue #77).

-- Decision 4: how many image blocks a forwarded request carried; NULL when the body was unreadable.
ALTER TABLE model_requests ADD COLUMN image_blocks INTEGER
  CHECK (image_blocks IS NULL OR image_blocks >= 0);

-- Decisions 5 to 8: one row per probe, kept as its receipt. The cache key is
-- (workspace_id, capability, model, endpoint_sha256, adapter_revision); at most one is pending.
CREATE TABLE model_capability_probes (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  capability        TEXT NOT NULL CHECK (capability IN ('vision')),
  model             TEXT NOT NULL,
  endpoint_sha256   TEXT NOT NULL,
  adapter_revision  TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('pending', 'supported', 'unsupported', 'unknown')),
  reason            TEXT CHECK (reason IS NULL OR reason IN (
                      'verified_answer', 'explicit_refusal', 'wrong_answer',
                      'no_transport_evidence', 'job_failed', 'blocked')),
  trigger           TEXT NOT NULL CHECK (trigger IN ('model_added', 'model_changed', 'startup', 'retry')),
  run_id            TEXT REFERENCES runs(id) ON DELETE SET NULL,
  code              TEXT NOT NULL,
  answer            TEXT,
  image_blocks      INTEGER,
  input_tokens      INTEGER,
  error             TEXT,
  requested_by      TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  finished_at       TEXT,
  CHECK ((status = 'pending') = (reason IS NULL)),
  CHECK (status <> 'supported' OR reason = 'verified_answer'),
  CHECK (status <> 'unsupported' OR reason = 'explicit_refusal')
);
CREATE INDEX model_capability_probes_key
  ON model_capability_probes(workspace_id, capability, model, endpoint_sha256, adapter_revision, created_at);
CREATE UNIQUE INDEX model_capability_probes_one_pending
  ON model_capability_probes(workspace_id, capability, model, endpoint_sha256, adapter_revision)
  WHERE status = 'pending';
CREATE INDEX model_capability_probes_run ON model_capability_probes(run_id);

-- Decision 10: a drafted SOUL is a proposal until an operator applies it.
CREATE TABLE soul_proposals (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  bot_id           TEXT NOT NULL,
  mode             TEXT NOT NULL CHECK (mode IN ('create', 'edit')),
  instruction      TEXT NOT NULL,
  base_version     TEXT NOT NULL,
  base_body        TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed', 'applied', 'discarded')),
  proposed_body    TEXT,
  run_id           TEXT REFERENCES runs(id) ON DELETE SET NULL,
  error            TEXT,
  applied_version  TEXT,
  requested_by     TEXT NOT NULL,
  decided_by       TEXT,
  created_at       TEXT NOT NULL,
  finished_at      TEXT,
  decided_at       TEXT,
  FOREIGN KEY (workspace_id, bot_id) REFERENCES bots(workspace_id, id) ON DELETE CASCADE,
  CHECK (status NOT IN ('ready', 'applied') OR proposed_body IS NOT NULL)
);
CREATE INDEX soul_proposals_bot ON soul_proposals(workspace_id, bot_id, created_at);
CREATE UNIQUE INDEX soul_proposals_one_pending ON soul_proposals(bot_id) WHERE status = 'pending';
CREATE INDEX soul_proposals_run ON soul_proposals(run_id);
