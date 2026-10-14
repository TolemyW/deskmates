-- Durable request rounds (ADR-0005 amendment 4, issue #110). One row per accepted originating
-- message; its member snapshot; and every run related to a member. Routing never reads these:
-- they attribute work for the chat's current-round strip and Activity (ADR-0033).

CREATE TABLE thread_rounds (
  message_id         TEXT PRIMARY KEY REFERENCES thread_messages(id) ON DELETE CASCADE,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id          TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  mode               TEXT NOT NULL CHECK (mode IN ('parallel', 'sequential', 'offer')),
  -- The round of the run that posted this message (a nested consultation), if any.
  parent_message_id  TEXT REFERENCES thread_rounds(message_id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL,
  cancelled_at       TEXT,
  cancelled_by       TEXT
);
CREATE INDEX thread_rounds_thread ON thread_rounds(thread_id, created_at, message_id);
CREATE INDEX thread_rounds_workspace ON thread_rounds(workspace_id, created_at);
CREATE INDEX thread_rounds_parent ON thread_rounds(parent_message_id);

CREATE TABLE thread_round_members (
  message_id  TEXT NOT NULL REFERENCES thread_rounds(message_id) ON DELETE CASCADE,
  bot_id      TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL,
  PRIMARY KEY (message_id, bot_id),
  UNIQUE (message_id, ordinal)
);
CREATE INDEX thread_round_members_bot ON thread_round_members(bot_id);

CREATE TABLE thread_round_runs (
  message_id  TEXT NOT NULL,
  bot_id      TEXT NOT NULL,
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  relation    TEXT NOT NULL CHECK (relation IN ('created', 'coalesced', 'retry')),
  created_at  TEXT NOT NULL,
  PRIMARY KEY (message_id, run_id),
  FOREIGN KEY (message_id, bot_id)
    REFERENCES thread_round_members(message_id, bot_id) ON DELETE CASCADE
);
CREATE INDEX thread_round_runs_member ON thread_round_runs(message_id, bot_id, created_at);
CREATE INDEX thread_round_runs_run ON thread_round_runs(run_id);
