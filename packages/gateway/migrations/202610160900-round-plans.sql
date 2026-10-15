-- Triaged rounds (ADR-0005 amendment 6, proposed; `DESKMATES_GROUP_ROUTING=round-v1` only). A
-- round's plan: the triage job that assigns members, the phase it is in, its closer and the
-- closer's one wake. Routing reads these under round-v1; the rounds of amendment 4 stay
-- presentation records.
CREATE TABLE thread_round_plans (
  message_id     TEXT PRIMARY KEY REFERENCES thread_rounds(message_id) ON DELETE CASCADE,
  phase          TEXT NOT NULL
                 CHECK (phase IN ('triage', 'working', 'closing', 'closed', 'fallback')),
  triage_run_id  TEXT REFERENCES runs(id) ON DELETE SET NULL,
  closer_bot_id  TEXT REFERENCES bots(id) ON DELETE SET NULL,
  closer_run_id  TEXT REFERENCES runs(id) ON DELETE SET NULL,
  -- Why triage fell back, or why the round closed without a closer wake.
  reason         TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
-- The plan a triage run ends, and the plan a closer run ends (`RoundPlanStore.byRun`).
CREATE INDEX thread_round_plans_triage_run ON thread_round_plans(triage_run_id);
CREATE INDEX thread_round_plans_closer_run ON thread_round_plans(closer_run_id);
-- Cascade from a deleted bot.
CREATE INDEX thread_round_plans_closer_bot ON thread_round_plans(closer_bot_id);

-- Decision 47: the members triage assigned, in the order it named them, each with one line.
CREATE TABLE thread_round_assignments (
  message_id  TEXT NOT NULL REFERENCES thread_round_plans(message_id) ON DELETE CASCADE,
  bot_id      TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL,
  task        TEXT NOT NULL,
  PRIMARY KEY (message_id, bot_id),
  UNIQUE (message_id, ordinal)
);
CREATE INDEX thread_round_assignments_bot ON thread_round_assignments(bot_id);
