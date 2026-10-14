# Interrupted usage receipts (issue #72)

Run detail and cost reports read durable proxy request and SDK turn observations when a
process exits, times out or is cancelled before its final report. Nullable counters remain
unknown; measured subtotals and prices are lower bounds, labelled `partial`. A started run
without measurements is `unknown`; a run that never started (queued, cancelled or failed
before start) without request/turn evidence is `not_started`, and does not degrade a report's
coverage. Coverage of several receipts combines by precedence (measured `partial` beats
`unknown`; `complete` with `unknown` is `partial`), never last-wins; an empty report has none.
A report's `runCount` counts runs with usage rows. A default attempt number is not evidence of
a model execution.

Proxy retries are separate physical requests. A proxy row without a served model is reduced
only by SDK observations of a model its requests are known to have been served as. SDK turn redelivery is deduplicated by attempt
and turn. Without shared response IDs the two sources contribute the per-model maximum,
not their sum. A final consumes matching observed counters once, preserving any measured
excess or other model as partial. Session fingerprints distinguish resumed and fresh sessions;
legacy receipts without identity keep a conservative lower bound and partial coverage.
Session baselines are frozen in gateway ledger events so final redelivery is idempotent.
A later session final can include an interrupted run's unknown tail; its residual remains
partial with `attributionUncertain`, not a complete measurement attributable to the later run.
Observed usage never advances the SDK session baseline by itself. Requested identities
(including rewritten aliases) and response-served identities remain separate; an unknown
served identity is never priced as though it were the requested model. An in-flight run's
unpriced observations are not counted as unpriced usage (its final may still be priced).

Cost queries project only usage-related events in one batched read per 500 selected runs
(plus one price lookup per model), not per-run queries. Large historical reports may still
need a materialized projection.
These receipts describe Gateway observations, not the provider's invoice.

`GET /api/workspaces/:id/restart-preflight` uses the same administrator/workspace
scope as restart and reports possible temporary access prerequisites without
mutating the runtime. Workspace responses can include `restorationRequirements`:
metadata-only historical notices retained after recreation (including failed new
runtime startup), merged by prerequisite identity; an `at_risk` notice a later inspection of
the current runtime no longer finds is cleared, historical notices stay. The restart response's
`restorationRequirements` are that restart's own findings; other stored notices are returned as
`outstandingRestorationRequirements`. Management shows manual restoration guidance. These notices do
not contain certificates or grant trust; the Gateway has no inventory proving
prior peer fingerprints, authorization or expiry. See
`docs/runbooks/legacy-volume-recovery.md` before any restoration.
