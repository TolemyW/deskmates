# B1–B3 consolidated closeout evidence

Status: testing handed off at the user’s request; this record does not yet close B2/B3.
See the [prioritized test handoff](../runbooks/m2-b1-b3-test-handoff-2026-09-23.md).
Further verification is not a prerequisite for unrelated development.
Plan: [consolidated closeout](m2-b1-b3-closeout-plan-2026-09-23.md).
All changes and verification are isolated in `codex/m2-foundation-20260922`.
The original application is not a test target or a deployment target.

## Corrections delivered

- Chief/group acceptance now checks the exact author, routing, reply count and
  terminal outcome specified by those fixtures. Existing later passing evidence
  satisfies the stronger assertions. This is not a general prohibition on bot
  progress messages, which ADR-0005 permits.
- A transient read transport failure no longer abandons an active acceptance run.
  Status GETs retry only recognized transport errors, with a bounded individual
  read and the original absolute wait deadline. HTTP, JSON and programming errors
  are not retried. No model call or business write is replayed. Retries are recorded
  with fixed, sanitized diagnostics and observation timestamps.
- The optional `inline-v2` browser mode returns a fresh accessibility tree after
  successful page-changing actions. It does one bounded, unscoped MCP snapshot,
  verifies the actual target/URL/takeover epoch before and after, refreshes the
  egress allowlist, and entity-escapes the appended page content. Snapshot timeout
  ends the uncertain MCP session and suppresses page-derived output while warning
  that the original action may have completed. No blind action retry is introduced.
- Snapshot mode is captured when a run is created and retained on approval resume.
  Its internal RPC has separate timing. Comparison runners reject simultaneous
  changes to model, image, role, completion, coordination or snapshot inputs when
  a one-variable model/snapshot comparison is requested.

`explicit-v1` remains the default. Inline snapshots are an intentional strategy
candidate, not a proven general improvement. `origin-v2` and `verified-stop-v1`
remain opt-in. The canonical 300-second deadline and 35-turn cap are unchanged.

## Flash smoke: all outcomes retained

The first attempt was incomplete: a transport error during a status GET aborted
the harness while its first run was still active. It is not a measured model
timeout or proof of a Gateway timer failure. The harness refused to reset active
state, and its original evidence remains in `work-closeout-flash-smoke-20260923`.
The corrected complete attempt has separate evidence in
`work-closeout-flash-smoke-r2-20260923`.

Model `glm5.3-flash`; original timing image
`sha256:ace5661c1869fa060e85e32cf27bc72090e428f034dec109efa6270edf66d2ee`;
baseline completion instructions, tab-v1, explicit-v1. This is a model-only
diagnostic against historical GLM evidence, not a contemporaneous model A/B.

| Task | Arm | Runtime | Requested state | Observed excess/error |
| --- | --- | --- | --- | --- |
| X02 refund | Solo | Timeout, 300.1 s | Complete | Inspected unrelated 1042/1077 after both labels; stale snapshot ref |
| X02 reassign | Solo | Timeout, 300.1 s | Complete | Repeated list/filter verification after all three confirmed writes |
| X02 refund | Concurrent | Timeout, 300.1 s | Complete | Continued checks and two thread-post attempts; no terminal summary |
| X02 reassign | Concurrent | Completed, 287.6 s | Complete | One recovered stale snapshot ref |
| X03 comment | Solo | Completed, 67.4 s | Complete | Strict checks pass |
| X03 reassign | Solo | Completed, 112.9 s | Complete | Strict checks pass |
| X03 comment | Concurrent | Completed, 264.3 s | Complete | Tried to close the peer's tab; correctly refused |
| X03 reassign | Concurrent | Completed, 243.2 s | Complete | Extra list check; strict checks pass |

No required target is missing; unrelated state, target identity and screenshot
attribution pass. Runtime completion is 5/8. X02 is **unclassifiable**, because its
solo controls fail. X03 is **interference under the existing canonical oracle**:
the peer-tab refusal fails its broad no-wait check. This does not demonstrate a
lost update, tab corruption, or a false denial of the run's own tab. Neither
assertions nor failed outcomes have been removed to change that verdict.

All eight runs contain timing: 1,470 complete spans, no unmatched starts, observed
wall coverage 97.4–99.3%. Model transport dominates; it includes upstream/network
time, not just inference. Concurrent X02 refund also has 62.1 seconds of capture
union, including four five-second capture timeouts and two no-image warnings.
Nested phase durations must not be added. This failed smoke is not expanded to K5.

## Inline r2 candidate and deterministic verification

Runtime/runner source: `f9e0451`; safety fixture extension: `42a5990`.
Image: `cogbot/workspace:m2-live-inline-closeout-r2-20260923`,
`sha256:faa373108132a2b32f5d301379e19dc00c6f19940c4118346a2dca65a3bf40e9`.
The image contains the runtime of `f9e0451`; the later commit changes only tests.
Validation logs are under `spikes/m2-business/work-closeout-validation-20260923`.

| Check | Result |
| --- | --- |
| Full T0/T1 and backend/acceptance typecheck | 1,123 tests / 80 files pass; typecheck passes |
| Runner configuration and timing analyzer | 11 Node tests pass |
| Real MCP/SDK inline navigation, typing and clicking | Pass; refs come from preceding action results, no explicit snapshot tool calls |
| Existing browser, snapshot/reference, group caps and explicit-silence T2 | 7 tests / 5 files pass |
| Default approval/takeover plus inline delivery/egress T2 | 4 tests / 3 files pass |
| Inline-v2 approval resume and two-run human takeover T2 | 2 tests / 2 files pass; original assertions unchanged |

An initial full-suite invocation lacked sandbox permission to listen on localhost
and failed with `EPERM`; the properly permitted run passed. An initial new T2
invocation used the wrong environment variable name and therefore selected the
old development image; it timed out. Both invalid setup attempts are retained
in separate logs and are not candidate runtime results. The dedicated-image
invocation passed. No shared image tag was built or overwritten by that attempt.

The scripted upstream establishes SDK/MCP contracts, not model capability.
Static denied egress is covered in T2; live allowlist revocation and refresh failure
are covered by deterministic proxy/run tests. Park/resume exercises allow-once;
the existing M1 deny/always gates are distinct.

## Same-image snapshot comparison

The predeclared paired smoke completed on model `glm-5.3`, runtime image above,
source `42a5990`, role v2, tab-v1 and baseline completion instructions. Test/host
source hashes and every run's recorded snapshot mode agree with the manifest.
Only snapshot delivery changes. Baseline executes first, then candidate; no
competing model or diagnostic-container job ran during these arms. A later
documentation-only plan commit does not change their frozen runtime or fixtures.

| Task | Arm | Explicit-v1 duration | Inline-v2 duration | Model-authored tool calls |
| --- | --- | ---: | ---: | ---: |
| X02 refund | Solo | 254.721 s | 174.788 s | 19 → 10 |
| X02 reassign | Solo | 271.269 s | 185.609 s | 23 → 14 |
| X02 refund | Concurrent | 223.853 s | 126.772 s | 17 → 10 |
| X02 reassign | Concurrent | Timeout, 300.089 s | 202.061 s | 28 → 14 |
| X03 comment | Solo | 84.105 s | 53.973 s | 7 → 4 |
| X03 reassign | Solo | 110.381 s | 101.022 s | 7 → 5 |
| X03 comment | Concurrent | 176.504 s | 186.371 s | 7 → 5 |
| X03 reassign | Concurrent | 179.261 s | 151.958 s | 7 → 4 |

Candidate: **8/8 completed; X02 and X03 canonical and strict checks both pass**.
Baseline: 7/8 completed; X02 fails canonically because concurrent reassignment
times out after all requested writes and repeated detail checks. Its solo
reassignment also has one strict-only stale-reference error. X03 passes.
The timeout is censored, not a completed latency measurement. One concurrent
short task is slower with inline delivery; no universal speedup is claimed.

Baseline used 115 model-authored tools, including 40 explicit snapshots. Candidate
used 66 tools and no explicit snapshot calls. All 66 internal snapshot RPCs
completed; all 66 corresponding ledger tool results contain the appended tree,
with zero tool errors or supplemental-read failure diagnostics. The model still
observes fresh state; those reads no longer require separate model decisions.

Capture warnings remain distinct: baseline has three capture errors, candidate
six, all on concurrent tabs. Candidate's concurrent X02 reassignment spends
47.135 seconds in capture union (34.659 in screenshot RPC); its concurrent X03
comment spends 13.346 seconds (8.335 in RPC). Successful screenshots retain correct
attribution. These errors neither disappear from evidence nor turn into failed
inline tree reads. They justify the separate background-capture probe.

Timing covers all eight runs per arm: 1,335 complete baseline spans and 1,090
candidate spans, zero incomplete/malformed samples. The single paired repetition
supports proceeding to fresh K5, not general strategy superiority or adoption.
Raw evidence: `work-closeout-inline-paired-20260923`; structured comparison:
`work-closeout-validation-20260923/snapshot-inline-paired-comparison.json`.

## Background capture reproduction

A separate no-model probe ran only after the model A/B finished, using the same
`faa37310` image and production container limits. Two independent pinned MCP
sessions share one headed Chromium. Eight rounds per arm retain the same target,
exact URL and round/counter identity; each round has a ten-second idle interval.
The MCP action deadline remains five seconds.

| Capture preparation | Background target A | Foreground target B |
| --- | --- | --- |
| Existing persistent focus emulation | 0/8; median 5,006.2 ms | 8/8; median 74.5 ms |
| Verify target, then bring that page forward | 8/8; median 54.8 ms | 8/8; median 52.5 ms |
| Existing emulation plus three background Chromium flags | 0/8; median 5,004.9 ms | 8/8; median 65.7 ms |

All sixteen failing captures reached `fonts loaded` before timing out in the
actual screenshot. The background flags were verified in Chromium's command line.
Every successful foreground-prepared capture retained the intended identity, and
round-eight A/B images were visually checked. All dedicated resources were removed.
Evidence: `spikes/m2-browser-capture/work-20260923T095928Z-72152`.

The follow-up concurrency probe also passed: two independent MCP sessions each
captured eight rounds in both natural overlap and forced foreground stealing, with
0/200 ms gaps. All 32 captures succeeded with matching target/URL/counter evidence.
No five-second boundary occurred. Evidence:
`spikes/m2-browser-capture/work-concurrent-20260923T101827Z-83522`.

## Final capture correction and handoff

Runtime revision: `c65f172f24e3ca0f88667ba4d2546108a2e50609`.
Image: `cogbot/workspace:m2-live-capture-closeout-r2-20260923`,
`sha256:9ba49192ee2ec46a1278b14cf94510d739a74225a794793f061b9b94768f3e99`.

The correction verifies target and exact URL, rechecks lease/epoch, brings the page
forward, and checks identity/control again before screenshot dispatch. The existing
post-capture fence remains. Ordinary result and accessibility-snapshot checks do
not change physical foreground. Preparation RPCs retain the five-second capture
bound; a timeout ends the uncertain MCP session. No new global lock or action retry.

At `49d8044`, the full T0/T1 suite passed 1,143 tests in 82 files. The final small
control-fence correction at `c65f172` passed all 41 coordinator tests and repository
typecheck. The final-image T2 batch was interrupted at the user's request. Its
partial log contains successful driver evidence for sixteen concurrent clicks and
sixteen correctly attributed images, but no complete suite pass is claimed. The
worker, dedicated container and its three volumes were removed. The original app
container remained running and unchanged.

No final-image real-model smoke, fresh K5 or named final model campaign was started.
Those checks are now delegated through the test handoff document, in priority order,
so development need not wait for a long acceptance campaign. Earlier image/model
results above remain evidence for their recorded configurations only. Full M2,
B4/B5, capacity, retained-tab cleanup, general strategy superiority, merge and
deployment remain distinct outcomes.

## Requirement inventory

This inventory reconciles original requirements and later evidence rather than
reopening superseded failures. Earlier model passes identify their own runtime
versions; they are not counted as new passes on this candidate.

| Original requirement | Executable evidence | Current closure condition |
| --- | --- | --- |
| B1 routing, ordered delivery, joins, coalescing, durable caps | Gateway router, group-foundation and direct-message tests | Framework closed; final model confirmation pending |
| B1 final-reply idempotency and direct message handoff | `m2-group-foundation.acceptance.test.ts` | Prior 20/20 matrix; final confirmation pending |
| B1/B3 group UI, activity and pause recovery | Web thread tests and prior isolated UI QA | Closed; UI unchanged in this batch |
| B2 stable targets, shared cookies, contention, concurrent ordinary clicks | `m2-browser.container.test.ts` | Reverified on inline r2 image; rerun if runtime changes |
| B2 same-target parked approval, exactly one approved action | `m2-browser-approval.container.test.ts` | Reverified with both snapshot modes |
| B2/B3 human takeover, screenshot suppression, recovery | `m2-takeover.container.test.ts` and model counterpart | T2 reverified in both modes; final model confirmation pending |
| B3 chief/expert chain, parallel mentions, silence, newcomer history | `m2-chief.acceptance.test.ts`, `m2-group.acceptance.test.ts` | Earlier gates pass; stronger final fixture confirmation pending |
| B3 explicit silence, relay/turn bounds and ledger alerts | `m2-group-silence.container.test.ts`, `m2-group-limits.container.test.ts` | Reverified on inline r2 image; rerun if runtime changes |
| X01 real billing delegation, exactly-once target writes | `m2-billing-chief.acceptance.test.ts` | Prior business K5 passes; later extra progress post remains a protocol diagnostic; final confirmation pending |
| B3 injection and budget measurement | Prior injection/group/X01 reports | Measurement performed; no universal security or budget-efficiency claim |
| B2 X02/X03 end-to-end completion and concurrency calibration | `m2-ticket-workflows.acceptance.test.ts` | Open; clean smoke and full fresh K5 required |

No other independent mandatory B1–B3 development gap was found in the original
foundation, browser-runtime and business-acceptance plans. Origin coordination,
snapshot delivery and completion wording are optional strategy candidates rather
than additional baseline feature requirements. See the original
[foundation plan](m2-foundation-plan-2026-09-22.md) and
[B3 results](m2-b3-completion-results-2026-09-23.md) for historical gate identities.
