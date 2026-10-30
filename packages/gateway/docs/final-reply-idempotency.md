# Final-reply idempotency and recipient context

A nonempty final reply reuses a bot message already persisted by the same run in the
same thread when their bodies match after outer whitespace trimming. It records a
`final_reply/deduplicated` ledger event referencing the existing message instead of
appending, consuming another turn, publishing another message event, or routing again.
Different text, runs and threads remain distinct. This check, completion state, usage,
and cursor advancement share the existing completion transaction. An empty final reply ends
the run `silent` only when the run posted no message through a tool; one that posted through
`thread_post` or `message_bot` ends `succeeded` (owner definition of 2026-10-17, ADR-0005
"Definition of `silent`").

**Visibility is reported beside the status (issue #70).** The run routes add `visibility`,
derived on read by `src/ledger/run-visibility.ts` through contracts' `deriveRunVisibility` from
the run's status, thread, final reply and the events the Gateway appends when it accepts a
`thread_post` / `message_bot` (`log` with `messageId`), an `approval_decide` (`approval`, phase
`decided_by_tool`) or a `task_deliver` (`log` with `taskId`): `finalReply`, `postedToThread`,
`decidedApproval`, `deliveredTask`, `visibleOutcome` for any of them, and `silent` by the owner's
definition: a thread run that ended `succeeded` or `silent` with neither a final reply nor a
posted message. A failed, cancelled or stopped run is never silent. No migration and no stored
row changes, so older runs, including those stored `silent` after a `thread_post`, are
classified by the same rule as new ones; nothing routes on the flags. The measurement doc's
pending confirmation (§3.6) is answered by the ADR-0005 section.

Thread deliveries carry the recipient identity, originating message sequence, and
per-message addressing derived from stored mentions. Coalesced messages keep their own
addressing; truncation never turns an omitted message into a fabricated task. The Gateway
records `threadContextVersion: 1` in the run configuration. These are routing facts, not
permission grants, and do not change routing, caps, lanes or teammate trust.
