# Per-bot working directories

Each bot works in its own directory by default (ADR-0038, owner-decided 2026-10-14).
`DESKMATES_BOT_WORKDIR` defaults to `per-bot`: a run starts in `/work/bots/<bot>`, which the
sidecar creates, and the prompt names that directory. `shared` keeps every run in `/work`
with the prompt it had before issue #88. The Gateway records the mode as `botWorkdir` in
`runs.config_json` when the run is created and sends the run row's value on every process
of that run, approval resume included.

In per-bot mode another bot's directory is read-only to a bot: the sidecar's `PreToolUse`
hook refuses file-tool writes and obvious shell writes there and tells the bot to write in
its own directory. `/work/uploads` is read-only to bots in every mode. Reading is never
refused, so deliverables stay in each bot's directory where teammates can read them; the
browser profile stays shared. **This is a soft guard against mistakes, not a security
boundary**: it reads the literal tool input, every bot runs as the same Unix user, and a
script or interpreter can still write anywhere. Work that must not be writable by another
bot belongs in a second workspace. OS-level isolation between bots is a later decision.

A workspace can store its own settings (ADR-0036 as amended by ADR-0038), read with
`GET /api/workspaces/:id/workdir` (Member) and changed with `PUT` (Admin, audited as
`workspace.workdir_set`):

- `mode` overrides `DESKMATES_BOT_WORKDIR` for that workspace; `shared` is the opt-out.
- `laneNotice` tells a run when the same bot has a live run on its other lane.

There is no `worktreeRepo` any more: each bot clones its own code into its directory, and a
`PUT` that sends `worktreeRepo` is a `validation` error. The migration
`202610141145-drop-workdir-worktree-repo.sql` dropped the column; run rows that froze one
keep it in `config_json` as history.

A run freezes its settings on its first process (`botWorkdir`, `botWorkdirSource`,
`laneNotice`, `workdirVersion` in `runs.config_json`); later processes send what the row
holds. Existing workspaces without a stored mode switch to per-bot at the release that
ships ADR-0038; a thread's SDK session is copied into the bot directory's key on its next
resume (sidecar `session-carry.ts`). Per-bot became the default by owner decision, without
the paired `evals/compare.ts` campaign; the per-run record keeps a later comparison possible.
