-- ADR-0005 amendment 3 (decisions 20 and 22, as rewritten on 2026-10-17): a paused thread records
-- why it paused, the seq of the message that caused it, when it paused and, for a turn-budget
-- pause, when the reset window ends and the thread resumes by itself. An operator pause has no
-- resume time. `budget_reset_seq` is the budget origin an unpause moves: the turn budget and the
-- loop breaker's volume and repetition rules count bot messages after both it and the latest
-- human message.
ALTER TABLE threads ADD COLUMN pause_reason TEXT
  CHECK (pause_reason IN ('turn_budget', 'operator'));
ALTER TABLE threads ADD COLUMN paused_seq INTEGER CHECK (paused_seq IS NULL OR paused_seq >= 0);
ALTER TABLE threads ADD COLUMN paused_at TEXT;
ALTER TABLE threads ADD COLUMN budget_reset_seq INTEGER NOT NULL DEFAULT 0
  CHECK (budget_reset_seq >= 0);

-- Before this migration a thread paused only on a turn-budget or loop-breaker breach; such a pause
-- gets the default reset window from the time it was last written. Its causing seq is unknown.
UPDATE threads SET pause_reason = 'turn_budget', paused_at = updated_at WHERE status = 'paused';

-- An active thread has no reason and no resume time; a paused one has a reason; only a
-- turn-budget pause has a resume time (decision 20, rewritten decision 22).
ALTER TABLE threads ADD COLUMN resume_at TEXT
  CHECK ((status = 'paused') = (pause_reason IS NOT NULL)
         AND (resume_at IS NULL OR pause_reason = 'turn_budget'));

UPDATE threads SET resume_at = strftime('%Y-%m-%dT%H:%M:%fZ', paused_at, '+60 minutes')
  WHERE pause_reason = 'turn_budget';

-- The scheduler's pass looks up the turn-budget pauses whose window has ended.
CREATE INDEX threads_resume_at ON threads(resume_at) WHERE resume_at IS NOT NULL;

-- The reset window is a workspace limit (`turnBudgetResetMinutes`, rewritten decision 22), set
-- by an Owner or Admin on the limits endpoint and audited as `workspace.limits_set`. SQLite
-- cannot widen a CHECK in place, so the table is rebuilt with one more key; rows are copied.
CREATE TABLE workspace_limits_new (
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  limit_key     TEXT NOT NULL CHECK (limit_key IN (
                  'continuationLimit', 'continuationWindowHours', 'maxTurns',
                  'relayCountMax', 'turnBudget', 'turnBudgetResetMinutes')),
  value         INTEGER CHECK (value IS NULL OR value >= 0),
  updated_by    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (workspace_id, limit_key)
);
INSERT INTO workspace_limits_new (workspace_id, limit_key, value, updated_by, updated_at)
SELECT workspace_id, limit_key, value, updated_by, updated_at FROM workspace_limits;
DROP TABLE workspace_limits;
ALTER TABLE workspace_limits_new RENAME TO workspace_limits;

-- Decision 23: an operator pause and resume are audited with the person who acted.
INSERT INTO audit_actions (action) VALUES ('thread.pause'), ('thread.resume');
