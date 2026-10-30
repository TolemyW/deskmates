-- ADR-0021 amendment 4 (issue #3 E1, D2): task templates are task kinds, a task's field values,
-- status and owner transitions for the kind view, one text vector per task for related tasks, and
-- `retrieval_calls` admitting the corpus `task`. Forward-only; existing rows keep their meaning.

-- A4a: a workspace's own templates. Built-in templates are Gateway constants, never rows. The
-- template body (description, stages with labelled criteria, review role, target, field
-- definitions) is a document read whole.
CREATE TABLE task_templates (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 48),
  name          TEXT NOT NULL CHECK (length(trim(name)) > 0),
  body_json     TEXT NOT NULL CHECK (json_valid(body_json)),
  sla_minutes   INTEGER CHECK (sla_minutes IS NULL OR sla_minutes > 0),
  version       INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by    TEXT NOT NULL,
  archived_at   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (workspace_id, kind)
);

-- A4c: a templated task's kind and the snapshot of the template it came from (read whole), and
-- its target copied out of the snapshot. NULL for every task created without a template.
ALTER TABLE tasks ADD COLUMN kind TEXT CHECK (kind IS NULL OR length(kind) BETWEEN 1 AND 48);
ALTER TABLE tasks ADD COLUMN kind_json TEXT
  CHECK ((kind IS NULL AND kind_json IS NULL) OR (kind IS NOT NULL AND json_valid(kind_json)));
ALTER TABLE tasks ADD COLUMN sla_minutes INTEGER CHECK (sla_minutes IS NULL OR sla_minutes > 0);
-- The kind view and related tasks read one workspace's tasks of one kind, newest first.
CREATE INDEX tasks_workspace_kind ON tasks(workspace_id, kind, created_at) WHERE kind IS NOT NULL;

-- A4c, A4h: field values of a templated task; `normalized` is what equal-value matching reads.
CREATE TABLE task_field_values (
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  field_key     TEXT NOT NULL,
  value         TEXT NOT NULL,
  normalized    TEXT NOT NULL,
  PRIMARY KEY (task_id, field_key)
);
CREATE INDEX task_field_values_match ON task_field_values(workspace_id, field_key, normalized);

-- A4f: every status or owner change of a task from now on, append-only. Earlier tasks have none.
CREATE TABLE task_transitions (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  field         TEXT NOT NULL CHECK (field IN ('status', 'owner')),
  from_value    TEXT,
  to_value      TEXT,
  changed_by    TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX task_transitions_task ON task_transitions(task_id, seq);
CREATE INDEX task_transitions_workspace ON task_transitions(workspace_id, created_at);

-- A4h: one L2-normalised float32 vector per task and embedding model, valid only for the text it
-- was computed from (`text_sha256`); no text is stored. Read only under the task's workspace.
CREATE TABLE task_text_vectors (
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  model         TEXT NOT NULL CHECK (length(model) > 0),
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  text_sha256   TEXT NOT NULL CHECK (length(text_sha256) = 64),
  dimensions    INTEGER NOT NULL CHECK (dimensions > 0),
  vector        BLOB NOT NULL CHECK (length(vector) = dimensions * 4),
  created_at    TEXT NOT NULL,
  PRIMARY KEY (task_id, model)
);
CREATE INDEX task_text_vectors_scan ON task_text_vectors(workspace_id, model);

-- A4h: ADR-0041 decision 8 records every embedding call; the related-task lookup is corpus
-- `task`. SQLite cannot widen a CHECK in place, so the table is rebuilt with every row kept.
-- Nothing references `retrieval_calls`.
CREATE TABLE retrieval_calls_next (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  run_id        TEXT REFERENCES runs(id) ON DELETE SET NULL,
  corpus        TEXT NOT NULL CHECK (corpus IN ('knowledge', 'memory', 'task')),
  purpose       TEXT NOT NULL CHECK (purpose IN ('index', 'query')),
  service       TEXT NOT NULL CHECK (service IN ('embedding', 'rerank')),
  model         TEXT NOT NULL,
  inputs        INTEGER NOT NULL CHECK (inputs >= 0),
  input_tokens  INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  duration_ms   INTEGER NOT NULL CHECK (duration_ms >= 0),
  outcome       TEXT NOT NULL CHECK (outcome IN ('ok', 'error', 'timeout')),
  created_at    TEXT NOT NULL
);
INSERT INTO retrieval_calls_next (id, tenant_id, run_id, corpus, purpose, service, model, inputs,
    input_tokens, duration_ms, outcome, created_at)
  SELECT id, tenant_id, run_id, corpus, purpose, service, model, inputs, input_tokens,
    duration_ms, outcome, created_at FROM retrieval_calls;
DROP TABLE retrieval_calls;
ALTER TABLE retrieval_calls_next RENAME TO retrieval_calls;
CREATE INDEX retrieval_calls_tenant ON retrieval_calls(tenant_id, created_at);
CREATE INDEX retrieval_calls_run ON retrieval_calls(run_id);

INSERT INTO audit_actions (action) VALUES
  ('task_template.archive'), ('task_template.create'), ('task_template.update');
