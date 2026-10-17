-- ADR-0038 decision 7 (owner-decided 2026-10-14): each bot clones its own code, so the platform
-- no longer prepares a git worktree of a shared repository and the workspace setting goes. Run
-- rows that froze a `worktreeRepo` keep it in `config_json` as history; nothing reads it.
ALTER TABLE workspace_workdir_settings DROP COLUMN worktree_repo;
