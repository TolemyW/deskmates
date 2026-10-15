# Runs index and run audit (ADR-0042)

Issue #11. Gateway side: [Run audit and ledger retention](../../gateway/docs/run-audit.md).

## Runs index

`features/run-index/`, route `runIndex` at `#/run-index`, a **Runs** link in the Operate group after Costs, shown to roles that may take `run.read` (Member and above). It lists the runs of the workspace selected in the sidebar, newest first, through `RunsApi.listRuns`; outside the shell (tests, demo) it sends no workspace and the Gateway scopes the list to the caller's workspaces.

Filters: status, bot (from `listBots` of the workspace), lane, a date range (`until` counts the whole day), failure class, and text over the error, applied on Search so typing does not send a request per key. Every other filter change refetches the first page with the composed filter; **Load older** follows `nextCursor` with the same filter. A row shows time, bot, lane, status, failure class, the mark badge, and its text: the run's Activity summary (ADR-0033) when one is ready, else the first line of its error or reply. A row opens the run drawer (`#/runs/<id>`).

## Run drawer: what this run changed

`features/runs/run-changes.tsx`, one element in `run.tsx`. It makes two requests, `GET /api/runs/:id/changes` and `GET /api/runs/:id/memory-versions`, once per run, and reads everything else from the run row: learned items with their trust, files changed, sites visited, the frozen model, skill set, SOUL version and system prompt hash. Memory "written" is what the run is the source of; memory "given" is what its context received. A pruned run says when it was pruned.

The section hosts `RunMarkControl` (`run-mark.tsx`) and, for a terminal run, **Save as replay fixture**: the browser cannot write to the repository, so it shows (and copies) `npm run replay -- export --gateway <this origin> --run <id>`, which writes `evals/traces/<id>.json` with the exporter; an authenticated Gateway needs `DESKMATES_OPERATOR_TOKEN`.

## Mark as wrong

`RunMarkControl` offers **Mark as wrong** with an optional note (at most 2,000 characters) to roles that may take `run.mark` (Owner, Admin), and **Unmark** on a marked run. The Activity card shows `RunMarkBadge` in its header and the control behind **Original**, so the card keeps its five lines (ADR-0033 decision 2); chats pass `markRun` to `ActivityPanel`. A Member sees the badge and, on a marked run, the role note.

Failure class labels are in `features/runs/failure-class.tsx` and the runs messages, in all five locales.
