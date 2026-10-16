# Run audit (ADR-0042)

Issue #11. Gateway side: [Run audit and ledger retention](../../gateway/docs/run-audit.md).

## Where runs are reached

There is no runs screen. A run is opened from where it happened: the Activity cards of a chat, an approval card, a task, or a link to `#/runs/<id>`, which opens the run drawer over the screen that was showing. The runs index of issue #11 (`#/run-index`, a **Runs** link in the Operate group with status, bot, lane, date, failure-class and text filters) was withdrawn by the owner on 2026-10-16: it listed raw errors next to successes and nobody triaged from it. The filters stay on `GET /api/runs` for scripts and for the compare tooling.

## Run drawer: the story first

`features/runs/run.tsx` leads with the run's status, bot, trigger and duration, then **What the bot is doing** (`run-story-panel.tsx`, derived by `run-story.ts` from the ledger alone): each `thinking` event heads a segment with the bot's first sentence (the whole thought opens on demand), and the tool calls, approvals, screenshots, takeovers, stalls, caps and model retries that follow are its steps, one verb and object per line (`Ran a command` with the command, `Opened a page` with the host and path, `Posted in the chat` with the first line). The open call of a live run ticks; a screenshot sits under the step that took it. Telemetry (`turn_usage`, compactions, memory bookkeeping, diagnostic logs) is not part of the story.

Everything else is behind two blocks: **Details** (facts, the run id, usage, the progress and intervention panel, startup timeline, phase timing, what the run changed) and **Technical log** (the raw ledger, oldest or newest first, diagnostic rows on request). A run waiting for a continuation opens Details with the intervention panel first.

## Run drawer: what this run changed

`features/runs/run-changes.tsx`, one element in `run.tsx`. It makes two requests, `GET /api/runs/:id/changes` and `GET /api/runs/:id/memory-versions`, once per run, and reads everything else from the run row: learned items with their trust, files changed, sites visited, the frozen model, skill set, SOUL version and system prompt hash. Memory "written" is what the run is the source of; memory "given" is what its context received. A pruned run says when it was pruned.

The section hosts `RunMarkControl` (`run-mark.tsx`) and, for a terminal run, **Save as replay fixture**: the browser cannot write to the repository, so it shows (and copies) `npm run replay -- export --gateway <this origin> --run <id>`, which writes `evals/traces/<id>.json` with the exporter; an authenticated Gateway needs `DESKMATES_OPERATOR_TOKEN`.

## Mark as wrong

`RunMarkControl` offers **Mark as wrong** with an optional note (at most 2,000 characters) to roles that may take `run.mark` (Owner, Admin), and **Unmark** on a marked run. The Activity card shows `RunMarkBadge` in its header and the control behind **Original**, so the card keeps its five lines (ADR-0033 decision 2); chats pass `markRun` to `ActivityPanel`. A Member sees the badge and, on a marked run, the role note.

Failure class labels are in `features/runs/failure-class.tsx` and the runs messages, in all five locales.
