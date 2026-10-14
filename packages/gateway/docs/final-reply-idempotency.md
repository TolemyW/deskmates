# Final-reply idempotency and recipient context

A nonempty final reply reuses a bot message already persisted by the same run in the
same thread when their bodies match after outer whitespace trimming. It records a
`final_reply/deduplicated` ledger event referencing the existing message instead of
appending, consuming another turn, publishing another message event, or routing again.
Different text, runs and threads remain distinct. This check, completion state, usage,
and cursor advancement share the existing completion transaction. Empty final replies
still end as `silent`, even when the run posted through a tool earlier.

**`silent` keeps its meaning; visibility is reported beside it (issue #70).** `silent` is
still an empty final reply (ADR-0005 decision 3). The run routes add `visibility`, derived on
read by `src/ledger/run-visibility.ts` through contracts' `deriveRunVisibility` from the run's
final reply and the events the Gateway appends when it accepts a `thread_post` / `message_bot`
(`log` with `messageId`), an `approval_decide` (`approval`, phase `decided_by_tool`) or a
`task_deliver` (`log` with `taskId`): `finalReply`, `postedToThread`, `decidedApproval`,
`deliveredTask`, and `visibleOutcome` for any of them. No migration and no stored row changes,
so older runs report the same flags as new ones; nothing routes on them. Measurement reads
them as `silent_run_cost_share` v2 (measurement §3.6).

Thread deliveries carry the recipient identity, originating message sequence, and
per-message addressing derived from stored mentions. Coalesced messages keep their own
addressing; truncation never turns an omitted message into a fabricated task. The Gateway
records `threadContextVersion: 1` in the run configuration. These are routing facts, not
permission grants, and do not change routing, caps, lanes or teammate trust.
