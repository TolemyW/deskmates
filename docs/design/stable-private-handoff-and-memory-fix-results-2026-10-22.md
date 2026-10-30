# Stable private handoff and memory-value correction

Date: 2026-10-22
Baseline: stable v0.7.10 at `6574c56`.
Follow-up to: [stable lifecycle and presentation check](stable-live-lifecycle-results-2026-10-22.md).
Decision: [ADR-0054](../adr/0054-preserve-current-values-in-multi-number-memory.md), owner accepted on 2026-10-22.
Result: the approved memory fix passes deterministic checks and captured-model replay;
private handoff completes with retained infrastructure and presentation issues.
No new release or deployment is claimed.

Private evidence: **Stable live lifecycle and presentation acceptance,
2026-10-22**, follow-up material: `final-with-private-handoff`, temporary-setting
and restoration receipts, private-handoff oracles/screenshots, exact original
model summaries and `memory-replay-result`. Deployment identifiers, raw
screenshots and credentials stay in the private lab.

## Authorization and cleanup

The owner explicitly authorized changing only the fixture assistant's
`messageAllowlist` from empty to `[analyst]`, performing one private handoff,
then restoring empty. The original attempt was rejected by approval review
before execution; it was not bypassed. The subsequent authorized test used one
reserved human message and the normal operator API. No other bot's settings or
workspace changed. The empty list was restored after all related runs ended.
The original private chat still has one bot member, no extra group was created,
and the current trusted workspace target remains 280 after the earlier normal
operator recovery. The three accepted-task publications remain unchanged.

## Private handoff observations

The assistant made one `message_bot` call. Analyst independently computed
214/280*100 with Python and returned 76.43%. Its execution happened in the
pairwise bus; its canonical private chat showed exactly one incoming-work card,
marked Completed and attributed to assistant. The browser followed both the
original-message link and Open collaboration; the exact request and result
were reachable. Opening the card cleared the signed-in browser operator's unread badge without
a second canonical-inbox run. The API caller's independent unread marker stayed
unread, consistent with per-operator read state. It is a completed bot run, not human task acceptance.

The outcome is **not a completely smooth pass**:

- The analyst's outcome was durably returned to the original private chat, but
  the assistant continuation there failed because the configured fallback model
  was unavailable. A separate assistant run in the bus produced the final
  "handoff complete" reply; the source chat exposed it as activity from elsewhere.
  The source's latest bot reply still promised a future result. That promise is
  not counted as completion. The failure and both paths are retained, with no
  manual resubmission to obtain a better outcome.
- The bus page said "Via internal" and called itself an external-channel mirror
  whose connection should be managed under Integrations. The code fix identifies
  it as Bot collaboration and explains private-chat follow-up, in all five
  locales, while retaining the existing read-only and approval behavior.
- The incoming card contains the request, status and links, but no inline result
  summary. Nearby silent acknowledgement activity is labelled Scheduled work.
  These make a simple handoff harder to scan than necessary; they remain product
  follow-ups, not fixed behavior claimed by this patch.
- The final assistant said it had not updated memory, but its summary submitted
  one untrusted task-scoped work note. It did not change the shared target; the
  literal "do not update memory" request was nevertheless not fully followed.
- The original chat renders a raw untrusted wrapper in the system outcome and
  the failed continuation's SDK stack. Model-context wrapping must remain;
  product presentation still needs a concise source/result view.

The nine additional runs comprise five interactive/background bot runs and four
inexpensive summary jobs. One failed, one was silent, seven succeeded. A receipt
card is not another execution. This test measured completion facts and visible
links; it does not estimate private-handoff reliability.

## Memory implementation and verification

The observed failure was in deterministic storage: the real model correctly
submitted "current280, replacing300", but the previous value and incoming one
shared the numeric set `280,300`. The approved implementation keeps the existing
fact key and value representation, review grouping, trust, clocks and recency.
Only the applied-note equivalence check changes: if either body contains more
than one numeric token after ISO-date and condition processing, consolidation
requires equal `normaliseMemoryBody` results. Repeated equal numbers count as
multiple tokens. Other wording passes through ordinary recency and preserves
the complete newer body. Single-number and nonnumeric equivalence is retained.

New runs stamp `memoryValuePolicy: multi-number-body-v1`; learned-memory event
receipts name the applied policy. Historical rows, supplied-memory versions and
recorded outcomes are not rewritten. No migration or Gateway inference is added.

T0/T1 regressions cover Chinese and English 280 -> 300 -> 280, reversed property
roles, repeated equal numbers, normalized exact copies, date/condition numbers,
late older arrivals, source idempotency, pinned context history and untrusted
supersession without promotion. The lifecycle check verifies policy attribution
on both the run and its write receipt. Existing review grouping uses the unchanged
`memoryFact`, so an unrelated rule-review grouping change is not bundled in.

A separate **offline replay** fed the three exact captured real-model learned
summaries into the new writer in a fresh in-memory fixture with their original
source clocks. All three applied, only the final trusted 280 was pinned, and all
three entries remained. There were **zero additional model calls** in this replay.
This demonstrates the storage correction for the actual counterexample, not a
fresh end-to-end run on a newly deployed release and not a paired quality result.
More history from equivalent multi-number paraphrases remains the accepted
tradeoff. Different fact keys and diary provenance are still heuristic limits.

## Cumulative run accounting

Including the earlier journey:47 logical runs / 47 physical attempts, 41 succeeded,
3 silent and 3 failed. No fixture run was active at capture. 43 have complete usage
coverage and 4 partial; all partial runs, fallback requests and failures remain.

| Configured model | Input | Output | Cache read | Cache create | Recorded configured-price USD |
|---|---:|---:|---:|---:|---:|
| glm53-internal |423090|26396|1133568|0|0.436616|
| deepseek-v4.1-flash-internal |1071|6130|7040|13760|0.011848|
| Total recorded |424161|32526|1140608|13760|0.448464|

Uncovered upstream usage is unknown, not zero. The price sum is not an invoice.
The workspace's existing USD 2 cumulative cap and 20-turn/no-continuation limits
were retained. No result-selecting retries or new paid memory campaign occurred.

## Checks and delivery boundary

The targeted contracts, memory store, policy receipt, run configuration and chat
presentation tests passed 61 checks. The captured-summary replay passed all three
steps. Full typecheck, lint, documentation consistency and web build passed;
the build retains its existing large-chunk warning.

The first full run passed 8313 tests and failed one existing Files filter/paging
fixture. Inspection showed the fixture clicked Next after seeing a request but
before its new page rendered, while Next was intentionally disabled. It now
waits for the button to become enabled, preserving production behavior. Its 15
focused checks passed. The final complete run after that correction passed all
883 files / 8314 tests in191.99 seconds on base `b456644`. Typecheck, lint,
documentation consistency, the public-identifier scan and the web production
build also passed. The initial failed run remains in the private evidence.

PR #75 merged during this work. The approved decision, implementation and this
follow-up are therefore reviewed on a new branch based on that merge. No T2/T3
release gate, statistically paired memory evaluation, tag or stable upgrade is
part of this follow-up. The live stable counterexample remains historical
failure evidence rather than being relabelled a pass after offline replay.
