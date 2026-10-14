-- ADR-0021 amendment 3 and ADR-0014 amendment A4 (issues #64, #74, #63): explicit task
-- triggers, keyed submissions, per-task schedules, soft deletion, formal deliveries with
-- server-verified file publications, and run-attributed checkpoints. Forward-only.

-- Scope version (A3f), soft deletion (A3e) and the create idempotency key (A3b).
ALTER TABLE tasks ADD COLUMN scope_version INTEGER NOT NULL DEFAULT 1 CHECK (scope_version > 0);
ALTER TABLE tasks ADD COLUMN deleted_at TEXT;
ALTER TABLE tasks ADD COLUMN deleted_by TEXT;
ALTER TABLE tasks ADD COLUMN create_key TEXT;
CREATE UNIQUE INDEX tasks_create_key ON tasks(workspace_id, create_key) WHERE create_key IS NOT NULL;

-- At most one schedule per task (A3d). `next_fire_at` is UTC; the cron text is read in `time_zone`.
CREATE TABLE task_schedules (
  task_id        TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('once', 'repeat')),
  run_at         TEXT,
  cron           TEXT,
  time_zone      TEXT NOT NULL,
  is_enabled     INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
  version        INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  next_fire_at   TEXT,
  last_fired_at  TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  CHECK ((kind = 'once' AND run_at IS NOT NULL AND cron IS NULL)
      OR (kind = 'repeat' AND cron IS NOT NULL AND run_at IS NULL))
);
CREATE INDEX task_schedules_workspace ON task_schedules(workspace_id);
-- The runner's one query: enabled schedules that are due.
CREATE INDEX task_schedules_due ON task_schedules(next_fire_at) WHERE is_enabled = 1;

-- One row per intended execution, keyed per task (A3b, A3c).
CREATE TABLE task_submissions (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('immediate', 'manual', 'scheduled')),
  submission_key  TEXT NOT NULL,
  scope_version   INTEGER NOT NULL,
  actor           TEXT NOT NULL,
  dispatch        TEXT NOT NULL CHECK (dispatch IN ('posted', 'skipped_overlap', 'missed')),
  occurrence_at   TEXT,
  thread_id       TEXT REFERENCES threads(id) ON DELETE SET NULL,
  message_id      TEXT REFERENCES thread_messages(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL,
  UNIQUE (task_id, submission_key)
);
CREATE INDEX task_submissions_workspace ON task_submissions(workspace_id);
CREATE INDEX task_submissions_task_created ON task_submissions(task_id, created_at);
CREATE INDEX task_submissions_thread ON task_submissions(thread_id);
CREATE INDEX task_submissions_message ON task_submissions(message_id);

-- A bot's formal delivery, complete or partial (A3g).
CREATE TABLE task_deliveries (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id           TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id            TEXT REFERENCES runs(id) ON DELETE SET NULL,
  attempt           INTEGER NOT NULL,
  delivered_by      TEXT NOT NULL,
  scope_version     INTEGER NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('complete', 'partial')),
  summary           TEXT NOT NULL,
  outstanding_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(outstanding_json)),
  created_at        TEXT NOT NULL
);
CREATE INDEX task_deliveries_workspace ON task_deliveries(workspace_id);
CREATE INDEX task_deliveries_task_created ON task_deliveries(task_id, created_at);
CREATE INDEX task_deliveries_run ON task_deliveries(run_id);

-- A verified formal result in Files (ADR-0014 A4 decision 24).
CREATE TABLE file_publications (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  delivery_id    TEXT NOT NULL REFERENCES task_deliveries(id) ON DELETE CASCADE,
  run_id         TEXT REFERENCES runs(id) ON DELETE SET NULL,
  bot_id         TEXT REFERENCES bots(id) ON DELETE SET NULL,
  path           TEXT NOT NULL,
  label          TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256         TEXT NOT NULL CHECK (length(sha256) = 64),
  check_kind     TEXT NOT NULL,
  checked_at     TEXT NOT NULL,
  scope_version  INTEGER NOT NULL,
  published_at   TEXT NOT NULL,
  superseded_at  TEXT,
  UNIQUE (task_id, path, sha256)
);
CREATE INDEX file_publications_workspace_published ON file_publications(workspace_id, published_at);
CREATE INDEX file_publications_delivery ON file_publications(delivery_id);
CREATE INDEX file_publications_run ON file_publications(run_id);
CREATE INDEX file_publications_bot ON file_publications(bot_id);

-- Progress a run records for a task; never a delivery, never published (A3h).
CREATE TABLE task_checkpoints (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id        TEXT REFERENCES runs(id) ON DELETE SET NULL,
  attempt       INTEGER NOT NULL,
  bot_id        TEXT REFERENCES bots(id) ON DELETE SET NULL,
  body_json     TEXT NOT NULL CHECK (json_valid(body_json)),
  created_at    TEXT NOT NULL
);
CREATE INDEX task_checkpoints_workspace ON task_checkpoints(workspace_id);
CREATE INDEX task_checkpoints_task_created ON task_checkpoints(task_id, created_at);
CREATE INDEX task_checkpoints_run ON task_checkpoints(run_id);
CREATE INDEX task_checkpoints_bot ON task_checkpoints(bot_id);

INSERT INTO audit_actions (action) VALUES ('task.delete'), ('task.run'), ('task.schedule_set');
