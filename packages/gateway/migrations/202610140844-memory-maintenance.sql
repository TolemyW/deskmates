-- ADR-0011 amendment 4 (issue #85 phase 2): the revalidation queue, Knowledge drafts from
-- observations with their citations, and model organisation jobs with their split proposals.

-- A26: one row per flagged note; at most one open row per note.
CREATE TABLE memory_revalidations (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entry_id       TEXT NOT NULL,
  entry_version  INTEGER NOT NULL CHECK (entry_version >= 1),
  reason         TEXT NOT NULL
                 CHECK (reason IN ('replaced_trusted', 'ttl_expired', 'ttl_expiring', 'age')),
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN (
                   'open', 'still_true', 'dismissed', 'resolved', 'superseded', 'forgotten')),
  horizon_days   INTEGER NOT NULL CHECK (horizon_days > 0),
  flagged_at     TEXT NOT NULL,
  decided_by     TEXT,
  decided_at     TEXT,
  CHECK ((status = 'open') = (decided_at IS NULL)),
  FOREIGN KEY (workspace_id, entry_id) REFERENCES memory_entries(workspace_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX memory_revalidations_open ON memory_revalidations(entry_id) WHERE status = 'open';
CREATE INDEX memory_revalidations_queue
  ON memory_revalidations(workspace_id, status, flagged_at DESC, id DESC);
CREATE INDEX memory_revalidations_dismissed
  ON memory_revalidations(entry_id, entry_version, reason) WHERE status = 'dismissed';
CREATE INDEX memory_revalidations_entry ON memory_revalidations(workspace_id, entry_id);

-- A26: when each workspace was last swept, so the periodic pass sweeps it at most once an hour.
CREATE TABLE memory_freshness_sweeps (
  workspace_id  TEXT NOT NULL PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  swept_at      TEXT NOT NULL
);

-- A29: a draft may target an existing document at one version, and cites the notes it was built
-- from at the version it read.
ALTER TABLE knowledge_proposals ADD COLUMN target_document_id TEXT REFERENCES knowledge_docs(id);
ALTER TABLE knowledge_proposals ADD COLUMN target_version INTEGER
  CHECK (target_version IS NULL OR target_version >= 1);
CREATE INDEX knowledge_proposals_target ON knowledge_proposals(target_document_id);

CREATE TRIGGER knowledge_proposals_target_tenant BEFORE INSERT ON knowledge_proposals
WHEN NEW.target_document_id IS NOT NULL
  AND (SELECT tenant_id FROM knowledge_docs WHERE id = NEW.target_document_id) IS NOT NEW.tenant_id
BEGIN SELECT RAISE(ABORT, 'knowledge document belongs to another tenant'); END;

CREATE TABLE knowledge_proposal_citations (
  proposal_id    TEXT NOT NULL REFERENCES knowledge_proposals(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL CHECK (position >= 1),
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entry_id       TEXT NOT NULL,
  entry_version  INTEGER NOT NULL CHECK (entry_version >= 1),
  PRIMARY KEY (proposal_id, position),
  FOREIGN KEY (workspace_id, entry_id) REFERENCES memory_entries(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX knowledge_proposal_citations_entry
  ON knowledge_proposal_citations(workspace_id, entry_id);

-- A31: where a topic came from; `model` labels name the job run that proposed them.
ALTER TABLE memory_entries ADD COLUMN topic_source TEXT NOT NULL DEFAULT 'rule'
  CHECK (topic_source IN ('rule', 'model'));
ALTER TABLE memory_entries ADD COLUMN topic_run_id TEXT;
CREATE INDEX memory_entries_model_topics ON memory_entries(workspace_id) WHERE topic_source = 'model';

-- A30: one organisation job per request; at most one pending per workspace.
CREATE TABLE memory_organize_jobs (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id          TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
  note_count      INTEGER NOT NULL CHECK (note_count >= 1),
  labels_kept     INTEGER NOT NULL DEFAULT 0 CHECK (labels_kept >= 0),
  labels_dropped  INTEGER NOT NULL DEFAULT 0 CHECK (labels_dropped >= 0),
  splits_kept     INTEGER NOT NULL DEFAULT 0 CHECK (splits_kept >= 0),
  splits_dropped  INTEGER NOT NULL DEFAULT 0 CHECK (splits_dropped >= 0),
  error           TEXT,
  requested_by    TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  finished_at     TEXT,
  CHECK ((status = 'pending') = (finished_at IS NULL))
);
CREATE UNIQUE INDEX memory_organize_jobs_pending ON memory_organize_jobs(workspace_id)
  WHERE status = 'pending';
CREATE INDEX memory_organize_jobs_workspace
  ON memory_organize_jobs(workspace_id, created_at DESC, id DESC);
CREATE INDEX memory_organize_jobs_run ON memory_organize_jobs(run_id);

-- A32: a kept split proposal and its parts; at most one pending proposal per note.
CREATE TABLE memory_split_proposals (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entry_id       TEXT NOT NULL,
  entry_version  INTEGER NOT NULL CHECK (entry_version >= 1),
  body           TEXT NOT NULL,
  job_id         TEXT NOT NULL REFERENCES memory_organize_jobs(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'accepted', 'rejected', 'undone')),
  created_at     TEXT NOT NULL,
  decided_by     TEXT,
  decided_at     TEXT,
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  FOREIGN KEY (workspace_id, entry_id) REFERENCES memory_entries(workspace_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX memory_split_proposals_pending ON memory_split_proposals(entry_id)
  WHERE status = 'pending';
CREATE INDEX memory_split_proposals_queue
  ON memory_split_proposals(workspace_id, status, created_at DESC, id DESC);
CREATE INDEX memory_split_proposals_job ON memory_split_proposals(job_id);
CREATE INDEX memory_split_proposals_entry ON memory_split_proposals(workspace_id, entry_id);

CREATE TABLE memory_split_parts (
  proposal_id  TEXT NOT NULL REFERENCES memory_split_proposals(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL CHECK (position >= 1),
  body         TEXT NOT NULL,
  -- The note an accepted split wrote for this part, at the version it left it; NULL when the
  -- part was folded into an existing note as one more source (A10), which undo leaves alone.
  entry_id       TEXT,
  entry_version  INTEGER,
  PRIMARY KEY (proposal_id, position)
);
CREATE INDEX memory_split_parts_entry ON memory_split_parts(entry_id) WHERE entry_id IS NOT NULL;

INSERT INTO audit_actions (action) VALUES ('memory.revalidate'), ('memory.split_decide');
