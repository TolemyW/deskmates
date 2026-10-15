# Run usage summaries (ADR-0032 amendment 1, issue #113)

The Costs page (`GET /api/costs`, `/api/costs/rows`, `/api/costs/ranking`) and cost alerts read
stored per-run summaries instead of rebuilding every run's usage receipt on each request.

- `run_usage_summaries`: one row per run with its receipt coverage (`complete`, `partial`,
  `unknown`, `not_started`), the estimate method version and when it was computed.
- `run_usage_summary_models`: one row per run and model with the four token counts, the number
  of receipt rows, and how many of them were priced, unpriced, unpriced observations, estimated,
  unestimated and unmeasured, plus known cost, estimated cost (null when none) and whether
  attribution is uncertain.

## When a summary is written

- `RunLifecycle.ended` writes it in the transaction that records the attempt's final usage.
- SQLite triggers delete it when an input changes: a `run_usage` insert, update or delete, a
  `model_requests` insert or update, a usage event (`turn_usage`, or a `log` from `sdk`,
  `usage_final`, `usage_session_baseline`), and a change of the run's `attempt` or `started_at`
  (a resume or the first start).
- A Costs read first computes and stores the summaries its selected runs lack. This is also the
  backfill for runs that existed before the migration.

## Reading

Totals, days, Activity rows and rankings are SQL `GROUP BY` queries over the summaries joined to
`runs`, `bots` and `workspaces`, with the report's filters. Whether a run is in flight comes from
its status at query time, so an in-flight run's observed rows are still not counted as unpriced.
Ordering, keyset cursors and every response field are the same as before;
`ledger/run-usage-summaries.test.ts` compares every report, row page and ranking with the earlier
per-request computation (`test-support/legacy-cost-report.ts`).

## Not re-priced

A price-table edit does not touch stored summaries; a run is priced again only when its own usage
changes. The budget (`budget_charges`) keeps its own append-only ledger and still charges from
live receipts while an attempt runs.
