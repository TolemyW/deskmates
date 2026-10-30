-- deskmates:foreign-keys-off
-- ADR-0029: a run the platform stopped at a safe point (a drain) or found live at a Gateway start
-- is parked as `waiting_platform` and continued by the Gateway, at most three times. SQLite cannot
-- widen a CHECK in place, so `runs` is rebuilt with the same columns, keys, indexes and triggers,
-- one more allowed status, and `platform_resumes`, read from `config_json` like the other
-- generated columns (decision 6 records the count there). Rows are copied unchanged.
CREATE TABLE runs_new (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  bot_id                TEXT NOT NULL,
  thread_id             TEXT,
  lane                  TEXT NOT NULL CHECK (lane IN ('interactive', 'background')),
  trigger_kind          TEXT NOT NULL REFERENCES run_trigger_kinds(kind),
  trigger_ref           TEXT NOT NULL,
  trigger_payload_json  TEXT CHECK (trigger_payload_json IS NULL OR json_valid(trigger_payload_json)),
  status                TEXT NOT NULL CHECK (status IN (
                          'queued', 'running', 'stalled', 'waiting_approval_live',
                          'waiting_approval', 'waiting_browser', 'waiting_continuation',
                          'waiting_platform', 'succeeded', 'silent', 'failed', 'cancelled',
                          'stopped')),
  attempt               INTEGER NOT NULL DEFAULT 1,
  sdk_session_id        TEXT,
  resume_payload_json   TEXT CHECK (resume_payload_json IS NULL OR json_valid(resume_payload_json)),
  delivered_seq         INTEGER,
  config_json           TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  summary_json          TEXT CHECK (summary_json IS NULL OR json_valid(summary_json)),
  error                 TEXT,
  -- Fields the Gateway filters or joins on, read from the JSON the run already records.
  run_type                 TEXT GENERATED ALWAYS AS (json_extract(config_json, '$.runType')) VIRTUAL,
  continuation_expires_at  TEXT GENERATED ALWAYS AS (json_extract(config_json, '$.continuationExpiresAt')) VIRTUAL,
  resume_approval_id       TEXT GENERATED ALWAYS AS (json_extract(resume_payload_json, '$.approvalId')) VIRTUAL,
  platform_resumes         INTEGER GENERATED ALWAYS AS (coalesce(json_extract(config_json, '$.platformResumes'), 0)) VIRTUAL,
  created_at            TEXT NOT NULL,
  started_at            TEXT,
  finished_at           TEXT,
  UNIQUE (workspace_id, id),
  -- The bot and the thread are in the run's workspace.
  FOREIGN KEY (workspace_id, bot_id) REFERENCES bots(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, thread_id) REFERENCES threads(workspace_id, id) ON DELETE CASCADE
);

INSERT INTO runs_new (id, workspace_id, bot_id, thread_id, lane, trigger_kind, trigger_ref,
                      trigger_payload_json, status, attempt, sdk_session_id, resume_payload_json,
                      delivered_seq, config_json, summary_json, error, created_at, started_at,
                      finished_at)
SELECT id, workspace_id, bot_id, thread_id, lane, trigger_kind, trigger_ref, trigger_payload_json,
       status, attempt, sdk_session_id, resume_payload_json, delivered_seq, config_json,
       summary_json, error, created_at, started_at, finished_at
  FROM runs;

-- A trigger on another table that reads `runs` would fail the rename below while `runs` is gone,
-- so it is dropped first and recreated unchanged after.
DROP TRIGGER approvals_same_run_bot;
DROP TABLE runs;
ALTER TABLE runs_new RENAME TO runs;

CREATE INDEX runs_bot_lane_status ON runs(bot_id, lane, status);
CREATE INDEX runs_bot_trigger ON runs(bot_id, trigger_kind, trigger_ref);
CREATE INDEX runs_bot_type ON runs(bot_id, run_type);
CREATE INDEX runs_status_created ON runs(status, created_at);
CREATE INDEX runs_bot_created ON runs(bot_id, created_at, id);
CREATE INDEX runs_thread ON runs(thread_id, created_at, id);
CREATE INDEX runs_workspace_created ON runs(workspace_id, created_at, id);
CREATE INDEX runs_workspace_bot ON runs(workspace_id, bot_id);
CREATE INDEX runs_workspace_thread ON runs(workspace_id, thread_id);
CREATE INDEX runs_workspace_status ON runs(workspace_id, status);
CREATE INDEX runs_resume_approval ON runs(resume_approval_id) WHERE resume_approval_id IS NOT NULL;
CREATE INDEX runs_continuation_expiry
  ON runs(continuation_expires_at) WHERE continuation_expires_at IS NOT NULL;

CREATE TRIGGER approvals_same_run_bot BEFORE INSERT ON approvals
WHEN NEW.bot_id IS NOT (SELECT bot_id FROM runs WHERE id = NEW.run_id)
BEGIN SELECT RAISE(ABORT, 'approval bot differs from its run'); END;

CREATE TRIGGER run_usage_summary_stale_attempt AFTER UPDATE OF attempt, started_at ON runs
WHEN NEW.attempt IS NOT OLD.attempt OR NEW.started_at IS NOT OLD.started_at
BEGIN DELETE FROM run_usage_summaries WHERE run_id = NEW.id; END;

-- Decision 8: an attempt that ended without the sidecar's usage (a restart, the deadline, a crash,
-- a forced stop) gets its rows from the `model_requests` its token made, marked `proxy`. A request
-- whose usage the upstream never reported makes the row incomplete: unknown, never zero.
ALTER TABLE run_usage ADD COLUMN source TEXT NOT NULL DEFAULT 'sdk'
  CHECK (source IN ('sdk', 'proxy'));
ALTER TABLE run_usage ADD COLUMN usage_complete INTEGER NOT NULL DEFAULT 1
  CHECK (usage_complete IN (0, 1));

-- Decision 6: the restart breaker counts Gateway starts in the database. `last_seen_at` is the
-- latest minute that process was alive, which decision 11 reads as when the previous Gateway
-- stopped, to name the cron minutes it skipped.
CREATE TABLE gateway_starts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  release       TEXT
);
CREATE INDEX gateway_starts_started ON gateway_starts(started_at);

-- Decisions 1 and 13: every drain a Gateway started, and when it was ended unforced. A drain still
-- open when its Gateway stopped led to that stop. The campaign report reads the time from a
-- drain's start to each run's safe point, and the drain attempts per release, from here.
CREATE TABLE gateway_drains (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  release     TEXT
);
CREATE INDEX gateway_drains_started ON gateway_drains(started_at);
