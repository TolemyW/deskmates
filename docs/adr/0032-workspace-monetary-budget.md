# ADR-0032: Workspace monetary budget and separated cost reporting

Date: 2026-10-13
Status: Proposed (for owner review; implements the owner decisions of 2026-10-13 on issues #61 and #112)
Source: issue #61 owner comments "Owner clarification: agent completion and workspace budget
backstop" and "Final owner decisions: pricing, budget period and continuation" (both 2026-10-13);
issue #112 reporting contract and the owner's wireframe choice (one page, a 金额 | 用量 toggle).
Builds on: ADR-0002 item 5 (the Gateway prices tokens; an unknown price is never zero), ADR-0018
(cost alerts stay soft), ADR-0031 decision 11 (audit record).

## Context

Cost alerts (ADR-0018) are soft: nothing stops a workspace from spending without bound. The
only hard ceilings today are counters that measure something else (SDK `maxTurns` per attempt,
the thread `turnBudget` of bot messages, `relayCount` hop depth, two continuations within 24
hours). The owner wants long work governed by money instead of by message counts, and has
ruled that the money backstop must exist before any of those counters is replaced.

The Costs page mixes units: a ranking switches an individual row from dollars to tokens when its
price is unknown, and the breakdowns are summed in the browser from day rows. Unknown prices
show as "unknown" with no estimate, so a workspace on an unpriced model has no measurable spend
at all, which a money budget cannot work with.

## Decision

1. **A workspace has two optional monetary limits, both off by default.** A weekly limit and a
   cumulative ceiling, in USD, each either absent (no limit) or a positive number. A new
   workspace has neither. Only an Admin of the workspace's tenant sets or clears them
   (`PUT /api/budgets/:workspaceId`); every change writes a `budget.set` audit row with the
   before and after values in the same transaction. Limits are operator data, not run knobs;
   a park records the limits in force when it happened.

2. **The week starts Monday 00:00 UTC.** Weekly spend is the spend charged in
   `[Monday 00:00 UTC, next Monday 00:00 UTC)`, independent of any workspace, browser or daylight
   saving time zone. Cumulative spend is every charge since the workspace began and never resets.
   Raising, lowering or clearing a limit never erases spend.

3. **Spend is an append-only charge ledger, priced when observed.** `budget_charges` holds, per
   workspace and run, the increments of the run's spend split into known and estimated USD,
   timestamped when the Gateway observed them. The Gateway recomputes a run's spend from the
   same usage receipts the run and cost APIs use, and appends the difference from what was
   already charged, at two moments: when a model response's usage lands at the model proxy, and
   when the run's final usage is recorded. A run that spans a week boundary is charged in the
   week each increment was observed. A receipt row whose tokens are unknown charges nothing and
   is never turned into zero tokens; the charge records how many usage rows had no measured
   tokens and how many had no price and no estimate. A later price-table edit does not rewrite
   past charges; a later observation of the same run carries the difference.

4. **An unknown price is estimated from the average configured unit price, per category.** For
   a usage row whose model has no price in force at the run's pricing time, each measured
   category (input, output, cache read, cache create) is priced at the arithmetic mean of that
   category's per-million price over the population of configured models, one in-force row per
   model at that time. Per-request totals are never averaged. The estimate carries its method
   version (`avg-unit-price-v1`) and population size; categories whose tokens are unknown stay
   unknown. When no model has a price in force the population is empty: there is no estimate,
   the row stays unpriced and is counted as unestimated coverage. Estimated cost is always
   reported separately from known cost and labelled as an estimate, never as a provider charge.
   Budget spend is known plus estimated cost.

5. **Admission is checked before every start and every model call.** A workspace is exhausted
   when its weekly spend is at or above its weekly limit or its cumulative spend is at or above
   its ceiling. The check runs in the scheduler before a queued run starts or a parked run
   resumes, and in the model proxy before each `POST /v1/messages` is forwarded
   (`count_tokens` is free and passes). There is no reservation: admission is accounting based.

6. **Exhaustion parks the work as "budget insufficient, waiting to continue", a typed state and
   not a failure.** Each park is an open `budget_parks` row naming the run, attempt, the limit
   reached, spend and limit; the run is never terminal because of it. In the scheduler, the run
   keeps its status (queued, or a parked status with a decided approval) and is not started or
   resumed while its park is open. In the model proxy, the request is answered `402`
   `budget_exhausted` with `x-should-retry: false` and never forwarded; when that attempt's
   process ends, the Gateway records its usage, keeps its handoff path and moves the run to
   `waiting_continuation` with a budget resume payload (session id, no approval), posting no
   reply and applying no learned memory, whatever outcome the process reported. A process that
   parked for an approval or for turn exhaustion keeps that park, and the open budget park also
   holds it. A run with no resumable SDK session cannot be checkpointed and fails with the typed
   error `budget_exhausted`. The open park, its limit and the spend are shown on the Costs page.

7. **Continuation is manual only.** An Admin continues parked work explicitly
   (`POST /api/budgets/:workspaceId/continue`, all parked runs of the workspace or the listed
   ones); it is refused with `409 budget_exhausted` while the workspace is still exhausted, so a
   continue never re-parks at once. It closes the parks with who and when, writes one
   `budget.continue` audit row, and kicks the scheduler. A run parked in the proxy resumes as a
   new attempt of the same SDK session with a `budget_continuation` trigger: a fresh user turn
   telling the bot to continue from its saved state and handoff. Nothing resumes at a week
   boundary or when a limit is raised: there is no timer, no scheduled continuation and no
   inference that a reset is permission. Stop (`POST /api/runs/:id/cancel`) works on parked runs
   as on any other; a stopped run's park closes as moot.

8. **Overshoot is bounded, not zero.** Enforcement is at request granularity, so a workspace can
   end above its limit by: every model request already in flight when the limit is crossed
   (each bounded by its own input tokens plus `max_tokens` output at its model's price, or at the
   estimate); usage the proxy did not observe and that arrives with the final receipt; the gap
   between an estimate and the real price; and usage that stayed unknown. The scheduler does not
   cap concurrent sidecars (ADR-0022 amendment 5), so the in-flight term scales with the
   workspace's concurrent model calls. The budget is not invoice exact and the UI says so.

9. **Costs show money and usage as separate views of one page.** The Costs page opens on 金额
   (money) every time and a 金额 | 用量 toggle switches the tiles, the daily chart and the
   rankings together; the choice is not remembered. Money shows known cost, estimated cost (with
   the estimate label and method version), unpriced coverage, and a total that is labelled
   "includes estimates" whenever it does. Usage shows input, output, cache-read and cache-create
   tokens. No list, tile or chart scale ever mixes dollars with tokens; a money ranking ranks
   known plus estimated USD and shows a row with neither as unpriced, never as zero. Rankings
   (by model, by bot, by workspace) are grouped by the Gateway for the whole filtered range
   (`GET /api/costs/ranking`) and paged ten per page; totals and the chart come from the full
   report, never from a page. A bot is labelled "bot · workspace" so two bots of the same name
   are distinguishable.

10. **The fixed execution controls are not changed by this ADR.** `maxTurns`, `turnBudget`,
    `relayCount` and the continuation limit keep their current values and meaning. Replacing
    message and delegation truncation with the budget is a follow-up that must amend ADR-0005
    (decision 6 turn budget, relay cap) and ADR-0016 (continuation count and 24-hour window)
    with their own verification, keep a separate cross-bot loop and progress breaker, and reuse
    the durable checkpoint identity of issue #63 rather than the budget resume payload.

## Alternatives

- **Reserving an estimated cost before each call.** Rejected for now: the request's output size
  is unknown before it runs, and a pessimistic reservation would park work that would have fit.
  Decision 8 states the resulting bound instead.
- **Refusing the tool call in the sidecar's PreToolUse hook.** Rejected: a pure text turn never
  reaches the hook, and the proxy sees every paid call in one place.
- **A new `waiting_budget` run status.** Rejected for this change: `runs.status` is a `CHECK`
  list, adding a value rebuilds the table (schema review F3), and a park row expresses the state
  without changing what every other reader of `status` means.
- **Resuming automatically after the weekly reset.** Rejected by the owner.
- **Charging runs to the week they were created in, as cost alerts file them.** Rejected: a run
  parked one week and continued the next would spend against a week that had already closed,
  and the weekly limit would never stop it.

## Verification

| Item | Concrete meaning | Test | Metric |
|---|---|---|---|
| 1 | No limits on a new workspace (admission admits any spend); PUT sets and clears each limit, rejects zero, negative and non-numbers with 400, is Admin only, and writes one `budget.set` audit row with before and after per change | T0 `packages/gateway/src/budget/budget-store.test.ts`; T1 `packages/gateway/src/api/budget-routes.test.ts` | limit changes per week (audit) |
| 2 | Week start for Sunday 23:59 UTC is the previous Monday, for Monday 00:00 UTC is that instant; a charge before the boundary leaves the new week's spend at zero and the cumulative unchanged | T0 `packages/gateway/src/budget/budget-week.test.ts`, `budget-store.test.ts` | none |
| 3 | Charging a run twice with no new usage appends nothing; new usage appends only the difference; unknown tokens charge nothing and are counted; known and estimated are separate columns | T0 `budget-store.test.ts` | charges per run (reported) |
| 4 | With two configured models the estimate of an unpriced row is the per-category mean of their in-force unit prices, not a mean of request totals; a future-dated price is excluded; an empty price table gives no estimate and the row stays unpriced; null categories stay null | T0 `packages/gateway/src/ledger/price-estimate.test.ts`; T1 `packages/gateway/src/api/cost-routes.test.ts` | estimated share of spend (reported) |
| 5 | An exhausted workspace's queued run does not start; under the limit it starts; the proxy refuses `/v1/messages` with 402 and passes `count_tokens` | T1 `budget-routes.test.ts` | parks per week (reported) |
| 6 | A proxy refusal opens a park and the ended run becomes `waiting_continuation` with a budget resume payload, no reply posted; a scheduler park leaves the run queued and unstarted; a run without a session fails with `budget_exhausted` | T1 `budget-routes.test.ts` | none |
| 7 | Continue is refused 409 while exhausted; after a raise it closes the parks, writes `budget.continue` and resumes the run with a `budget_continuation` trigger in a new attempt; raising the limit alone resumes nothing; cancel works on a parked run | T1 `budget-routes.test.ts`; T0 `packages/sidecar/src/start-run-request.test.ts` | none |
| 8 | The overshoot terms are documented here and in the Costs budget panel; a request in flight when the limit is crossed completes and its usage is charged | T1 `budget-routes.test.ts` (in-flight request charged after the limit) | overshoot per park (reported) |
| 9 | The page opens on money; the toggle swaps tiles, chart and rankings; no ranking row shows tokens in money view; the total says "includes estimates" when estimated cost is present; same-name bots show their workspace; ranking pages of ten do not change the totals | T0 `packages/web/src/features/costs/costs.test.tsx`; T1 `cost-routes.test.ts` | none |
| 10 | `maxTurns`, `turnBudget`, `relayCount` and the continuation limit keep their values: the existing tests for them still pass unchanged | T1 `packages/gateway/src/scheduler/run-lifecycle.test.ts`, `packages/gateway/src/threads/router.test.ts`, `packages/gateway/src/m2-group-foundation.test.ts` | none |

## Consequences

- Contracts gain `budget.ts` (limits, spend, park, verdict shapes, `weekStartUtc`), estimated
  fields on the cost shapes, the ranking shapes, and the `budget_continuation` trigger kind.
- Gateway: one migration (`workspace_budgets`, `budget_charges`, `budget_parks`, two audit
  actions); `budget/` module; `ledger/price-estimate.ts`; admission hooks in the scheduler and
  the model proxy; the budget park branch in `RunLifecycle.ended` and `resume`; budget routes in
  the costs policy domain.
- Sidecar: accepts the `budget_continuation` trigger and words its turn.
- Web: the Costs page toggle, separated tiles, chart and paged server rankings, and a budget
  panel per workspace with edit and Continue.
- Follow-up, not done here: amend ADR-0005 and ADR-0016 to replace fixed truncation with the
  budget (decision 10); a cross-bot loop breaker; #63 checkpoint identity; per-run overshoot
  measurement on a real model.

## Amendment 1 (2026-10-14): a stored per-run usage summary feeds the Costs page

Status: Owner-decided (2026-10-14; issue #113, owner decision group 14: "不同模型的能分开就行").

### What was wrong

Every Costs request (`GET /api/costs`, `/api/costs/rows`, `/api/costs/ranking`) and every cost
alert evaluation rebuilt the usage receipt of every run in the filtered range from `run_usage`,
`run_events` and `model_requests`, priced it, estimated it and grouped it in JavaScript. The cost
of a page view grew with the history, and a price-table edit silently re-priced every past day.

### Decision

11. **A run's usage summary is computed once and stored, per model.** `run_usage_summaries` holds
    one row per run (its receipt coverage, the estimate method version and when it was computed);
    `run_usage_summary_models` holds one row per run and model: the four token counts, how many
    receipt rows it combines, how many were priced, unpriced, unpriced but still observational
    (a lower bound of an in-flight attempt), estimated, unestimated and unmeasured, the known cost,
    the estimated cost and whether attribution is uncertain. The values are exactly what the
    receipt projection and the decision 4 estimate give at that moment.

12. **When it is computed.** The Gateway writes the summary when an attempt ends, in the same
    transaction that records the final usage. Any later change to the summary's inputs deletes it:
    a SQLite trigger fires on a new or updated `run_usage` row, a new or updated `model_requests`
    row, a new usage event (`turn_usage`, or a `log` from `sdk`, `usage_final` or
    `usage_session_baseline`), and a change of the run's `attempt` or `started_at` (a resume or a
    first start). A run without a summary (a run that existed before this amendment, an in-flight
    attempt, usage that landed after the end) is computed by the first reader that needs it and
    stored then; that is the backfill, done lazily rather than in the migration because the
    projection is code, not SQL.

13. **Costs read the summaries with SQL grouping.** Totals, days, Activity rows and rankings are
    `GROUP BY` queries over the stored summaries joined to `runs`, `bots` and `workspaces`, with the
    same filters as before. Whether a run is in flight is read from its current status at query
    time, so an in-flight run's observational rows are still not counted as unpriced. Row order,
    keyset cursors, ranking order and every field of the responses are unchanged.

14. **History is not re-priced.** Editing the price table changes no stored summary; a run is
    priced again only when its own usage changes (decision 12). Budget charges (decision 3) keep
    their own append-only ledger and are unchanged.

### Verification (amendment 1)

| Item | Concrete meaning | Test | Metric |
|---|---|---|---|
| 11 | on fixtures with finals, proxy-only, in-flight, attribution-uncertain, unpriced-estimated, unpriced-unestimated and never-started runs, the stored per-model summary matches the receipt projection and its estimate | T0 `packages/gateway/src/ledger/run-usage-summaries.test.ts` | none |
| 12 | `ended` writes the summary; a new usage row, model request, usage event or attempt change deletes it; a run without one is computed and stored by the first report | T0 `run-usage-summaries.test.ts`; T1 `packages/gateway/src/ledger/run-usage-summary-lifecycle.test.ts` | none |
| 13 | report, rows, days and every ranking from the summaries equal the earlier per-request computation on the same fixtures, with and without filters; existing cost route tests pass unchanged | T0 `run-usage-summaries.test.ts` (legacy comparison); T1 `packages/gateway/src/api/cost-routes.test.ts`, `cost-pages.test.ts`; T0 `packages/gateway/src/ledger/costs.test.ts` | Costs request latency (reported) |
| 14 | after a price edit a summarised run's known cost and estimate are unchanged; a run whose usage changes afterwards is priced with the edited table | T0 `run-usage-summaries.test.ts` | none |
