# Per-bot working directory experiment

`DESKMATES_BOT_WORKDIR` defaults to `shared`: every run starts in `/work` with the
prompt it always had. The opt-in `per-bot` mode (issue #88, ADR-0004 amendment 1)
starts a run in `/work/bots/<bot>`, which the sidecar creates, and the prompt names
that directory, says `/work` is shared, and asks the bot to use its own `git worktree`
there for a shared repository. The Gateway records the mode as `botWorkdir` in
`runs.config_json` when the run is created and sends the run row's value on every
process of that run, approval resume included. It is a convention, not access
control: nothing checks which directory a tool call touches. The Gateway creates no
worktrees. `per-bot` is a strategy change; it stays opt-in until a paired
`evals/compare.ts` campaign supports it, and none has been run.
