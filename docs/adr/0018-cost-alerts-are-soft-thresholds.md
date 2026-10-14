# ADR-0018: Cost alerts are soft thresholds on Gateway-priced usage

Date: 2026-10-02
Status: Accepted (product owner, 2026-10-10; rules, alerts and the Costs UI have shipped on the stable deployment; issue #24 changes only their presentation). Originally proposed for the M3 roadmap item "cost alerts"; design v0.3 §3.7 "aggregated per bot per day, with an optional soft-limit alert". Amended by ADR-0026 on 2026-10-11: fixed usage and cost history is retained while its owner exists, but an explicitly confirmed permanent deletion from Trash removes that live history.
Builds on: ADR-0002 item 5 (the Gateway prices tokens; an unknown model is unpriced, never zero)

## Context

The Gateway prices every usage row at record time from its own price table and reports cost by UTC day, bot and model (`GET /api/costs`, the Costs screen). What is missing is the alert the design promised: nobody is told when a bot or the deployment crosses a spend line, and unpriced usage, which the cost report shows as "unknown", can grow unnoticed. The M3 inventory asks that threshold, window, reset, deduplication and the notification contract be settled before implementation, that unknown usage and attempt totals be preserved, and that enforced budgets and external delivery stay out unless adopted.

## Decision

1. **A rule is a soft threshold, never a budget.** A cost alert rule has a scope (every bot, or one bot), a window (`day` or `month`, UTC calendar units, the same bucketing the cost report uses), and one of two kinds: `known_cost` with a `thresholdUsd > 0`, which fires when the window's known cost reaches the threshold; or `unpriced_usage`, which fires when the window holds at least one usage row with no price. A firing alert changes nothing about scheduling: no run is refused, stopped or delayed because of it.

2. **Evaluation happens when usage lands, in the window the report files it under.** Rules are evaluated synchronously in `RunLifecycle.ended`, right after the run's usage rows are recorded, for the rules whose scope covers that run's bot. The windows evaluated are the UTC day and month that contain the run's creation time, because that is where `GET /api/costs` files the usage: a run created at 23:50 UTC that ends after midnight counts on the day it started, not the day it ended. There is no timer and no backfill: a price row added later does not re-price stored usage (cost is fixed at record time while the workspace or bot remains live), so it does not fire or clear anything. ADR-0026's explicitly confirmed permanent deletion is the sole retention exception and removes the target's usage, cost and alert rows. The window totals are the cost report's own query over runs created in the window, so the alert and the screen always agree.

3. **One alert per rule per window.** `(rule, windowKey)` is unique, with `windowKey` the UTC day `YYYY-MM-DD` or month `YYYY-MM`. The first evaluation that satisfies the rule in a window fires once; later usage in the same window fires nothing; the next window starts clean. Raising a threshold after it fired does not re-arm the window; deleting and recreating the rule does.

4. **Notification is in-product and carries the unknowns.** A firing writes a `cost_alerts` row, appends a `cost_alert` run event to the run whose usage crossed the line, and publishes a `cost_alert` SSE frame. The payload names the rule, the scope, the window key, the threshold, and the window's `knownCostUsd`, `unpricedUsageCount`, `runCount`, `usageCount` and token totals exactly as the cost report computes them, so an alert never hides that part of the spend is unknown. An operator acknowledges an alert (`POST /api/cost-alerts/:id/acknowledge`); acknowledging is bookkeeping and does not re-arm the window. Delivery to email, chat channels or pagers is not part of this ADR; a later ADR may subscribe a channel adapter to the SSE frame.

5. **Rules are operator data, not run knobs.** Rules live in SQLite behind the authenticated operator API (`GET/POST /api/cost-alert-rules`, `DELETE /api/cost-alert-rules/:id`) and are not stamped into `runs.config_json`: an alert changes no run's behaviour, so it is not something a result has to be attributed to.

6. **The Costs screen shows both, live.** Open alerts with their window facts and an acknowledge action, and the rule list with create and delete. The panel subscribes to the SSE feed and reloads on a `cost_alert` frame and on reconnect, so an alert that fires while the page is open appears without navigation. Nothing else in the UI changes.

## Alternatives

- A hard budget that parks or refuses runs past the threshold: rejected for now; the inventory lists enforcement as separate scope and it would need a resume semantics of its own.
- Evaluation on a minute timer: rejected; usage changes only when a run ends, and a timer would fire alerts with no run to attach the event to.
- Rolling 24-hour windows: rejected; they do not match the day the cost report shows and would make "did it fire today" undecidable from the screen.
- Delivering alerts into a thread as a system message: rejected; it would wake bots on an operator fact and spend tokens on the alert itself.

## Verification

| Item | Concrete meaning | Test | Metric |
|---|---|---|---|
| 1 | A `known_cost` rule fires when the window's known cost is at or above `thresholdUsd` and not below; an `unpriced_usage` rule fires on the first unpriced row and not on priced ones; a fired alert leaves run statuses and queues unchanged; `thresholdUsd <= 0` or a kind/window outside the vocabulary is 400 | T0 `packages/gateway/src/ledger/cost-alerts.test.ts`; T1 `packages/gateway/src/api/cost-alert-routes.test.ts` | alerts fired per week (reported) |
| 2 | A run that ends with usage evaluates the rules of its bot and the global rules before `ended` returns; a run ending with no usage fires nothing; a `PUT /api/prices` fires nothing | T1 `cost-alert-routes.test.ts` through `/internal/runs/:id/ended` with the fake provider | none |
| 3 | Two runs crossing the line in one day produce one alert; a run on the next UTC day produces a second; raising the threshold after firing produces nothing more that day; a run created on 2026-09-30 that ends on 2026-10-01 fires the 2026-09-30 day rule and the 2026-09 month rule | T0 `cost-alerts.test.ts`, which passes the run's creation time as the lifecycle does | none |
| 4 | The alert row, the `cost_alert` run event on the crossing run and one SSE frame exist together and carry the same `knownCostUsd` and `unpricedUsageCount` as `GET /api/costs` for the window; acknowledge sets `acknowledgedAt` and the alert leaves the open list | T1 `cost-alert-routes.test.ts` | unpriced usage rows per window (reported) |
| 5 | Rules exist only through the authenticated routes; `runs.config_json` carries no alert field | T1 `operator-auth.test.ts` (every `/api/*` route rejects without the credential); `run-lifecycle.test.ts` config snapshot unchanged | none |
| 6 | The Costs screen lists open alerts with window facts, acknowledges one, creates and deletes a rule, and shows an alert delivered by a `cost_alert` SSE frame without a reload | T0 `packages/web/src/features/costs/cost-alerts.test.tsx` | none |

## Consequences

- `contracts` gains `cost-alert.ts` (rule and alert shapes, window helpers); `RunEventKind` gains `cost_alert`.
- Gateway migration `0024-cost-alerts.sql`; `ledger/cost-alerts.ts`; `api/cost-alert-routes.ts`; one call in `RunLifecycle.ended`; a `cost_alert` variant on the event bus.
- Web: alerts and rules on the Costs screen; `cost_alert` joins the known SSE event types.
- Budget enforcement and external delivery remain unimplemented and are listed as such in the M3 closeout, not implied by this ADR.
