# M3 actual SDK cross-run memory lifecycle

Date: 2026-10-03 Asia/Taipei. Selected mechanical lifecycle passes; full M3 open.
Actual SDK 0.3.278 inside the current production workspace image, real Gateway,
SQLite and authenticated operator routes; scripted local upstream, no real model.
No production change, new strategy knob, commit, release or deployment.

## Reserved chain

The final invocation reserves five logical/physical SDK queries, maxTurns 4 and
120 seconds per attempt. The two initial observations reserve four each. The
selected T2 has a 600-second bound, runner 840;
no browser bounds or production quiet/cooldown thresholds change.

| Phase | Actual runtime operation | Observed invariant |
| --- | --- | --- |
| Trusted source | Independent human-triggered SDK session reports one bot candidate before reading untrusted content | Trusted candidate and source run recorded; it later joins the untrusted candidate/episode in the consolidation input |
| Search | memory_search reads an explicitly seeded untrusted page-derived fixture item; SDK returns task/candidate/imperative learned items claiming trusted | Item absent from pinned index; search entity-escapes its forged closing tag; task/candidate are stamped untrusted, imperative gated and unapplied |
| Operator versions | Human confirms source, edits version 2 to 3, undoes to 4 | Trusted human source and exact original body restored; immutable versions remain |
| Resume | New run in the same thread resumes the first SDK session, returns another learned workspace fact | Sticky session taint remains despite the operator's confirmation of the original source; claimed trust is overridden |
| Close | Operator closes task notes twice | Exactly one episode with minimum/untrusted source trust; second close is idempotent, closed source ID retained |
| Consolidate | Manual operator request creates an actual SDK background run over candidate/episode sources | Untrusted provenance recorded in run config; proposed bot note is gated with untrusted_sources and absent from applied memory |
| Human review | Apply the factual consolidation result, reject the imperative | Bot note becomes trusted/human, full episode/source provenance retained; no SOUL change |
| Forget and fresh session | Forget original and resumed workspace facts, then run memory_search in a newly created thread | Two tombstones, all prior version bodies redacted, no forgotten fact/task/imperative in new first context, search empty; confirmed bot note is present, fresh session is not tainted |

The initial untrusted seed is an explicit fixture insertion, not a newly measured
page/browser trust transition. Actual memory_search and resumed-session propagation
are measured here; page-to-memory stamping has its separate existing T2.
The queries' facts and consolidation content are scripted, not model judgments.

## Retained initial assertion failure and prompt finding

work-01 completes all four SDK runs and the entire memory chain, then fails its
last prompt-hash assertion. That oracle incorrectly compares ordinary context
with background consolidation's intentionally different guidance, and raw SDK
wire prompts across new sessions. Its original test source, receipts, four
successful run rows and failed Vitest assertion remain retained.

The corrected oracle compares the product's assembled ordinary system prompt
across growing memory/diary and separately verifies no learned body enters any
wire system prompt. It records the actual wire blocks instead of discarding
differences. work-02 passes, one assertion/no skip, 12.80-second Vitest invocation
(12.05 seconds in the test file). This is a fixture correction, not a production
bug fix or a discarded unsuccessful real-model task.

An independent audit then finds that work-02's candidate and episode are both
untrusted; it does not prove mixed-trust handling. Final work-03 adds an independent
actual SDK trusted candidate, verifies both trust levels in the consolidation's
saved source set and preserves both prior observations. It passes one selected
T2/no skip. No production change or strategy adjustment follows this extension.

Independent comparison of work-02's raw SDK systems finds:

- Same resumed session: ordinary wire system byte-identical.
- New ordinary SDK session: only block 0 differs. It is the SDK's
  x-anthropic-billing-header, whose cc_version=2.1.278 suffix varies from a85
  to 3e7. Every remaining ordinary system block is byte-identical.
- Product assembled ordinary prompt hash remains
  `155fe75d5aafb22be91ec105ec646a16a7cca0cd14d905c0dad927421fb86744`.
- Consolidation's different declared guidance is recorded separately.

Do not infer full wire byte identity from the product hash, nor real cache hit
rates from this scripted upstream's synthetic zero cache counts. No SDK version,
header, cache control or prompt strategy was changed to force equality.

## Accounting, binding and cleanup

All three invocations count: **thirteen actual SDK logical/physical queries,
nineteen messages POSTs, zero real models**. Each initial observation has four
successful attempt-1 runs, three distinct sessions, six proxy responses and
synthetic input 102387/output 386. Final work-03 has five successful attempt-1
runs, four distinct sessions, seven proxy responses and input 119500/output 471.
SDK final usage and independently recorded proxy sums match. Aggregate input
324274/output 1243, cache read/create 0/0, cost unknown/null. No usage is discarded
for the initial fixture failure.

Final work-03 run identities:

- Trusted candidate `run_7bdc983b8e2c4121bc7e71def39eb3fa`, session
  `c8c91637-b9c8-4863-ae51-963c8cb9cd5f`.
- Search `run_26734b010c8d4762bfb05f587f82390a` and resume
  `run_7a7a55da2a4548a7a6e7ccd13359ebd2`, session
  `ab6c8f04-40fc-48ae-a3fd-8e4c9b34cbfe`.
- Consolidation `run_6afc9e25186843f08bad5b8814344146`, session
  `09519a74-cbae-4bf1-884e-91c2dfec78ee`.
- Fresh `run_0f1893ae3ea741099815f906cdfd44e2`, session
  `9e1a3fcd-554f-4a44-9336-f80eaf7c059f`.

Workspace image stays
`sha256:0e35564b70f87800f99750bd5d3637d35cc5e910aadd17307763e59c1a89f4ff`;
egress `sha256:625ee0e145b3299366d8fc7ff45bf95853d806ab8f39f2e5d4d66b3d123a319f`.
Reuse requires source/compiled parity with the final turn-usage work-03 build.
All 984 runtime inputs match at each invocation's termination; later initial
fixture/test-helper changes are explicitly separated. Selected T2 source:
`4264b48b9a8ff9ec02f8f30354e96d8a2a1037daed86396137bd83d7531b035c`.
Final proof: `149d01ee81a0b03d48792150e05be56e3975514d2d2db4e58311fabfe74cf54c`.
Independent three-invocation audit:
`f10331c46c9cba0903ff8959e635ef25f00fd596c890afc431ef8fda5352a5c7`.
The earlier corrected proof/audit keep their separate four-query source binding.

Read-only SQLite integrity/FK checks pass on all three retained ledgers. All
eighteen exact Docker identities are independently absent; runner PIDs 21967,
22659 and 31234 and their groups are absent. No prefix cleanup or stable touch.
Root typecheck and lint pass; complete T0/T1 **2475 pass, zero fail/skip** includes
the smoke-list classification. Initial fixture typing
errors (canonical SOUL getter and expanded confirmation DTO) are retained in
local typecheck logs, corrected before any query, without casts or production
changes. The smoke classification adds this new file after the selected test.

## Limits and remaining gates

The earlier 3530ec94 full 90-pass T2 gate retains its exact original inventory;
this one selected new test extends mechanical coverage on unchanged production
inputs. It is not a newly executed full 91-test suite. Full configured-model
memory protocol, ordered five-session retention/poison trials and paired strategy
acceptance remain open. Actual Gateway/container restart and real quiet/cooldown
duration are not exercised here. Forget proves memory store/version/index/search
behavior, not removal from an existing SDK transcript, diary/export or ledger.

Subsequent selected actual SDK restart coverage is recorded separately in
`m3-sdk-memory-restart-results-2026-10-03.md`. It exercises Gateway SIGKILL,
workspace recreation with persistent transcript hashes, tainted resume and
forgetting across a graceful restart/fresh session; it does not change this
test's original coverage or establish the remaining quality gates.

No real-model campaign is launched. Its expanded scope confirmation and WABA
configuration remain pending. See `m3-closeout-evidence-matrix-2026-10-03.md`.
