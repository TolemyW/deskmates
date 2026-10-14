-- Workspace monetary budget (ADR-0032): optional limits, an append-only charge ledger and parks.

-- Decision 1: both limits optional; no row means no limit.
CREATE TABLE workspace_budgets (
  workspace_id          TEXT NOT NULL PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  weekly_limit_usd      REAL CHECK (weekly_limit_usd IS NULL OR weekly_limit_usd > 0),
  cumulative_limit_usd  REAL CHECK (cumulative_limit_usd IS NULL OR cumulative_limit_usd > 0),
  updated_by            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

-- Decision 3: increments of a run's spend, timestamped when observed. `run_id` has no foreign
-- key on purpose: a purged bot's runs go, its spend stays in the workspace's cumulative total.
CREATE TABLE budget_charges (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id             TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id                   TEXT NOT NULL,
  charged_at               TEXT NOT NULL,
  known_usd                REAL NOT NULL,
  estimated_usd            REAL NOT NULL,
  unmeasured_usage_delta   INTEGER NOT NULL,
  unestimated_usage_delta  INTEGER NOT NULL,
  estimate_version         TEXT
);
CREATE INDEX budget_charges_workspace ON budget_charges(workspace_id, charged_at);
CREATE INDEX budget_charges_run ON budget_charges(run_id);

-- Decision 6: one open park per run; Continue closes it (decision 7).
CREATE TABLE budget_parks (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id          TEXT NOT NULL,
  attempt         INTEGER NOT NULL,
  checkpoint      TEXT NOT NULL CHECK (checkpoint IN ('admission', 'model_call')),
  limit_kind      TEXT NOT NULL CHECK (limit_kind IN ('weekly', 'cumulative')),
  spend_usd       REAL NOT NULL,
  limit_usd       REAL NOT NULL,
  week_starts_at  TEXT NOT NULL,
  parked_at       TEXT NOT NULL,
  resolved_at     TEXT,
  resolved_by     TEXT,
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX budget_parks_workspace_run ON budget_parks(workspace_id, run_id, parked_at);
CREATE UNIQUE INDEX budget_parks_open_run ON budget_parks(run_id) WHERE resolved_at IS NULL;

INSERT INTO audit_actions (action) VALUES ('budget.continue'), ('budget.set');
