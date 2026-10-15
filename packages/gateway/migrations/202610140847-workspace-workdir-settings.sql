-- Per-workspace working-directory settings (ADR-0036). One row per workspace that stores at
-- least one setting; no row means every setting inherits (the mode from DESKMATES_BOT_WORKDIR, no
-- worktree, no lane notice). A convention and tooling, never access control: no hook reads it.
CREATE TABLE workspace_workdir_settings (
  workspace_id   TEXT NOT NULL PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  mode           TEXT CHECK (mode IS NULL OR mode IN ('shared', 'per-bot')),
  -- Decision 2: a worktree repository only together with a stored per-bot mode.
  worktree_repo  TEXT CHECK (worktree_repo IS NULL OR mode = 'per-bot'),
  lane_notice    INTEGER NOT NULL DEFAULT 0 CHECK (lane_notice IN (0, 1)),
  updated_by     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

INSERT INTO audit_actions (action) VALUES ('workspace.workdir_set');
