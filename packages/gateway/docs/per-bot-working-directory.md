# Per-bot working directory experiment

`DESKMATES_BOT_WORKDIR` defaults to `shared`: every run starts in `/work` with the
prompt it always had. The opt-in `per-bot` mode (issue #88, ADR-0004 amendment 1)
starts a run in `/work/bots/<bot>`, which the sidecar creates, and the prompt names
that directory, says `/work` is shared, and asks the bot to use its own `git worktree`
there for a shared repository. The Gateway records the mode as `botWorkdir` in
`runs.config_json` when the run is created and sends the run row's value on every
process of that run, approval resume included. It is a convention, not access
control: nothing checks which directory a tool call touches.

A workspace can store its own settings (ADR-0036, Proposed), read with
`GET /api/workspaces/:id/workdir` (Member) and changed with `PUT` (Admin, audited as
`workspace.workdir_set`):

- `mode` overrides `DESKMATES_BOT_WORKDIR` for that workspace.
- `worktreeRepo`, a git repository under `/work` (needs a stored `per-bot`), makes the
  sidecar prepare `/work/bots/<bot>/<repo name>` on branch `bots/<bot>` before the query,
  with the image's `git`. It never resets, pulls, merges or removes anything.
- `laneNotice` tells a run when the same bot has a live run on its other lane.

A run freezes them on its first process (`botWorkdir`, `botWorkdirSource`,
`worktreeRepo`, `laneNotice`, `workdirVersion` in `runs.config_json`); later processes
send what the row holds. Nothing is stored by default. Each setting is a strategy
change; none becomes a default until a paired `evals/compare.ts` campaign supports it,
and none has been run.
