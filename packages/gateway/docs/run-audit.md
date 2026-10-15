# Run audit and ledger retention (ADR-0042)

Issue #11. What the Gateway gives an operator who has to find out why runs failed, what a run changed, and tell the learning loop that a run was wrong; and how the run ledger is pruned.

## Failure class

`src/ledger/failure-class.ts` derives a class from `runs.error`: `model_unavailable`, `model_deadline`, `tool_allowlist`, `egress_blocked`, `approval_denied`, `wall_clock`, `sdk_abort`, `no_reply`, `budget_limit`, `other`. Nothing is stored; every run view carries `failureClass` when the run has an error, and the run list filters on it in SQL. One ordered table of lower-case substrings (`FAILURE_RULES`) is applied by `classifyFailure` and rendered by `failureClassSql`; the first rule that matches wins, so a root cause ("model not found", "no worker available", a 5xx the SDK retried) is named before the deadline that ran out waiting for it.

A new error shape lands in `other`. To classify it, add its substring to the right rule and a real-shaped string to the corpus in `failure-class.test.ts`; the test checks every corpus string in code and in SQL, and with every model job name, current and old, around it.

## Run list filters

`GET /api/runs` takes, besides `threadId`, `botId`, `workspaceId`, `phase`, `cursor` and `limit`:

| Parameter | Meaning |
| --- | --- |
| `status` | one run status, or several separated by commas |
| `lane` | `interactive` or `background` |
| `since`, `until` | ISO 8601 times on `created_at`; `until` is exclusive |
| `failureClass` | one class above |
| `q` | case-insensitive substring of `error`, at most 200 characters used |

They compose with each other and with the workspace and private-chat scoping in SQL, so a page is never short, and they are part of the cursor's scope: a cursor from another filter is refused. An unknown status, lane, class or time is 400.

## What a run changed

`GET /api/runs/:id/changes` (Member) returns `RunChanges`: every approval the run asked for with its decision, the task checkpoints it wrote and the task artifacts it delivered (ADR-0021), the learned-memory entries whose source is the run at their current version (a forgotten one is listed tombstoned with no body), its mark, and `prunedAt` when retention pruned it. Each list holds at most 200 rows. The rest of the drawer section comes from the run row and from `GET /api/runs/:id/memory-versions`, which lists the memory the run was given, not what it wrote.

## Mark as wrong

`PUT /api/runs/:id/mark` with `{note?}` (Owner or Admin of the run's workspace) marks the run wrong or replaces its note; `DELETE /api/runs/:id/mark` removes the mark and answers `{removed}`. The row in `run_marks` is the run's do-not-learn flag:

- `memory/entries.ts` `consolidationInput` and the eligibility counter in `memory/consolidation.ts` leave out experience candidates whose source run is marked, so an automatic or manual consolidation neither counts nor takes them;
- a run marked before it ends records each learned item as `memory_skipped` with reason `marked_wrong` and writes none (`scheduler/run-lifecycle.ts`);
- removing the mark makes the candidates consolidation input again.

Entries the run already applied stay; forget or edit them in Learned memory. Marks cascade with the run and the workspace.

## Retention

`RUN_EVENTS_RETENTION_DAYS` is off when empty or 0. Set to a number of days, the Gateway runs a pass at startup and then hourly (`src/ledger/run-retention.ts`): for terminal runs that finished longer ago, oldest first and at most 200 per pass, it deletes their `run_events`, `run_usage` and `model_requests` rows. It keeps:

- the run row, its summary and configuration, its approvals and its mark;
- its Activity summaries (`run_activity_summaries`, ADR-0033);
- its Costs summary: `run_usage_summaries` is computed before the usage rows go and written back after the deletion triggers drop it, so Costs totals do not change. Budget spend lives in `budget_charges` and is not touched.

A run with an approval nobody has decided is never pruned. Each pruned run gets one `run_retention_prunes` row (time, limit, counts), which the run drawer shows and which stops a second pass from touching it again.

A pruned run cannot be replayed or exported as a trace, and its event list and per-model usage receipt are empty. **Export before you prune**: before setting the variable, or lowering it,

1. back up the database (`docs/runbooks/multi-tenant.md` section 5; the online backup can run while the Gateway does);
2. export the runs you want to keep as replay fixtures: `DESKMATES_OPERATOR_TOKEN=<token> npm run replay -- export --gateway <operator URL> --since <ISO time>` (or `--run <id>` per run) writes `evals/traces/<runId>.json`.

The Gateway does neither for you.
