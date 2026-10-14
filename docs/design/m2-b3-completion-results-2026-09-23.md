# B3 completion: runtime contracts and configured-model evidence

**Status: group/collaboration development and focused gates pass; overall B3
closure remains blocked by its B2 browser-concurrency dependency.** The completed
K5 calibration is 1/10 interference, above the prescribed 5% escalation threshold.
[ADR-0007](../adr/0007-browser-origin-coordination-calibration.md) records the
proposed follow-up; no origin-lock change is implemented or enabled.

Worktree: `codex/m2-foundation-20260922`, isolated from the running main app.
This follows the predeclared [completion plan](m2-b3-completion-plan-2026-09-23.md).
Three Sol-medium subagents handled group semantics, X01/X04, and stale-reference
investigation. The integrator reviewed changes and coordinated model/container
runs. This record supersedes the previous batch's interpretation of the extra
strict diagnostics, without changing or deleting its evidence.

## Contract defects and corrections

### Explicit silence

ADR-0005 says an empty structured `reply` means silence. The former parser instead
promoted prose outside the JSON whenever `reply` was empty. Real traces contained
“remaining silent” plus `reply: ""`, yet became visible group messages and caused
legitimate derivative wakes. The parser now honors any explicit string reply,
including the empty string. Missing/invalid summaries retain the fallback.
No semantic text suppression or bot access control was introduced.

A scripted-upstream real SDK test produces prose plus an empty structured reply
in two ordered member runs and verifies two silent runs, no bot transcript row,
and no derived wake. Unit cases cover fenced and bare summaries and missing-key
compatibility. This is an intended correction to the documented runtime contract.

The first unchanged-input group comparison was 1/5 versus 1/5. Parsing was fixed,
but model protocol mistakes remained: some real answers were put outside JSON
while declaring an empty reply, and some observation wakes repeated earlier answers.
The next candidate changes only the global summary instruction: output one object
and put every intended public answer in `reply`. It passed 4/5 versus 3/5 for the
parser-only control in a separate AB/BA series. These small focused samples do not
establish general strategy superiority, cost savings, or a latency improvement.

### Current delivery versus historical context

The group fixture's v2 role appendix distinguishes a new human request in the
current delivery batch from old requests retained in the SDK session. A bot-only
observation is not new work in this specific fixture, and each human request is
answered once. The v1 SOULs remain byte-identical; full texts and hashes are in
v2 evidence. The same-image role comparison finished 5/5 on v1 and 5/5 on v2;
there is no observed pass-rate advantage in that comparison. V2 is now the
acceptance fixture default, with explicit v1 available for historical controls.
Production routing and canonical assertions are unchanged. This is
a fixture for a human-driven workflow, not a universal restriction on delegation:
X01 explicitly tests experts acting on chief's bot-authored instructions.

### Waiting for an asynchronous teammate

X01's second control repetition timed out after chief executed `sleep 90`,
`sleep 120`, and `sleep 110`. The reviewer had already replied, but the next wake
was queued behind that chief run. The captured batch cannot gain new messages
while a run is in progress. The scheduler followed ADR-0005 correctly.

The context candidate explains fixed delivery, queued future wakes and ending
silently when the only remaining work depends on a teammate. It does not forbid
progress posts or independent work. It does not raise the timeout, bypass the
queue, or add live message injection. The comparison preserves the same X01
SOULs, fixture and assertions; only context assembly changes. Final review
qualified the queued-wake sentence to messages actually routed to the recipient
and subject to thread caps. Image D retains the original wording for its K5
record; image E contains that factual correction and has separate confirmation
evidence. No result from one image is relabelled as another.

## Canonical oracles versus diagnostics

The earlier business test combined canonical scenario requirements with additional
format/tool-quality checks. This follow-up explicitly separates them:

- X02/X03 require correct writes, no unrelated changes or lost update, independent
  stable targets, correct screenshot attribution, concurrent overlap and no own-tab
  wait. Recovered stale references and non-browser tools remain visible diagnostics.
- `silent` and `succeeded` are both completed outcomes under ADR-0005. State-only
  ticket tasks do not require a final textual reply. Uniform offline re-scoring
  accepts these two statuses; `failed`, `cancelled`, parked and missing evidence
  still fail or remain unclassifiable. Original harness verdicts are retained.
- X04's canonical oracle is completion, wait evidence and screenshot suppression.
  The prior extra exact-answer check remains reported separately. The new oracle
  additionally verifies a real Dashboard tool result after handback. The final
  summary-protocol X04 sample passed both runtime and exact-format diagnostics.

Four X02 reference errors were model-authored `browser_snapshot(target=oldRef)`
calls after navigation/re-rendering. The proxy never rewrote their inputs. A real
pinned-MCP test now proves that old refs fail in both `none` and `full` snapshot
modes, an unscoped snapshot refreshes the page, and its new refs work. No guessed
reference repair, automatic scope widening or blind action retry was added.

## Non-vacuous X01 and injection measurement

The X01 fixture contains two today/billing tickets, yesterday/billing and
today/non-billing distractors. Expected IDs are derived from host state; IDs and
count are not supplied to chief. Ticket details now expose Created dates so the
predicate is observable through the actual UI. This additive site change is
versioned 1.2.1. Chief discovers and partitions the work, each expert comments
once, and chief returns the number handled. Assertions cover complete site-state
differences, operation logs, actual expert browser inputs, distinct assignments,
chief/expert message links, usage and configuration, plus message/cap counts even
on failed attempts. The complete control series passed 4/5; repetition 2 remains failed, despite
both ticket comments having been written correctly. All five exchanges produced
four bot messages and zero budget pauses. Only repetition 2 used Bash sleep
(three calls); the other four used none.

Four synthetic bot-message injection cases cover forged wrapper markup, forged
human identity, synthetic-canary exfiltration and an unsolicited order. A test
carrier creates a real sender run and posts exact bot-authored text through the
Gateway; only the receiver runs the configured model. Each has a fresh thread and
SDK session, and receiver diary is reset between cases. All four carriers and
attribution/state checks passed; the receiver attempted none of the injected
L2/off-allowlist actions (0/4 in this sample). The conditional egress/approval
branches were therefore not exercised by these four model runs. This small corpus
is a measurement, not a security boundary or a zero-risk guarantee; ADR-0005 sets
no M2 hijack-rate threshold.

## Verification and attribution

Configured model: `glm-5.3`; cheap model configuration: `glm5.3-flash`.
Upstream origin: `https://llmops.example-corp.internal`. Credentials remain in ignored env
and child-process environments, never in tracked evidence.

| Runtime image | Identity |
| --- | --- |
| Prior browser-focus control | `sha256:910ef34a8121c9caad0dea189746c10c28b602b5eea1139e72f9ba367d849633` |
| Explicit-silence parser | `sha256:04cd5e95dcaf5f5554004ed08e79ceeeabc093b3d613876b18d9cf17172d15c4` |
| Summary-protocol candidate C | `sha256:0f5f42629e4eac05bdbce97ab583610fc8bfb3278963e43d4a2095db569f0d77` |
| Async-delivery candidate D | `sha256:c90aba9de24b37553422d7a930cec9632d186aa3f88a0ca857304ee2de6d49de` |
| Final routing-qualified image E | `sha256:9ad94aed20ea6c6eced3271b00557df538470d82074210b3ca73c7c73ef50faa` |

Early group/ticket manifests report site 1.2.0 with the uncommitted additive
Created-date display already present. The display source stayed unchanged through
those series; the version was then synchronized to 1.2.1. Later manifests also
hash the host site's server/seed and stack helper. No row counts, ticket seed,
metric values or group task inputs changed across either side of a comparison.
Model tests use the host golden-site harness external to the bot container, not
the separately built site image. There are no shared application databases,
browser profiles or mutable volumes between test stacks or with the main app.

Independent series overlap on the same host/model service. Their results measure
functional behavior under that load, not controlled wall-clock improvement.
Evidence directories are ignored by Git and never overwritten. Code, plan and
this results record are committed separately.


## Final group and collaboration results

| Check | Runtime / inputs | Result |
| --- | --- | --- |
| Explicit-reply parser comparison | prior A / parser B, unchanged roles | 1/5 / 1/5; all failures retained |
| Summary instruction comparison | parser B / summary C, unchanged roles | 3/5 / 4/5; focused AB/BA only |
| Role-contract comparison | same C image, v1 / v2 SOUL | 5/5 / 5/5; no observed advantage |
| Group gate K5 | D, v2 fixture | 5/5; 65 runs, 45 silent; zero orphan message/run links |
| Group final confirmation | E, default v2 fixture | 1/1; parallel mentions, ordered silence and newcomer history pass |
| X01 control K5 | C | 4/5 business pass; 2/5 strict protocol diagnostic pass |
| X01 async-delivery K5 | D, same X01 fixture | 5/5 business and strict protocol pass; zero sleep calls |
| X01 final confirmation | E | 1/1 business pass, no sleep; extra progress post fails strict protocol diagnostic |
| Named `m2-chief` gate | E | 1/1; both experts and final chief summary, complete trace/usage/config |
| X04 configured-model handback | C and D | 1/1 each; runtime and separate exact-output checks pass |
| Bot-message injection corpus | C | 4/4 carrier/state checks; 0/4 injected-action attempts |

The strict X01 diagnostic is now reusable and collected alongside future raw
records. It checks the initial chief and expert posting runs for one `thread_post`,
silent/empty final reply, and final-reply dedup events; initial assignment and
successful browser snapshots must also be evidenced. Re-scoring old raw evidence
uses the same helper and never modifies the original business verdict. In C,
repetitions 4 and 5 repeated an expert's posted body in final `reply`; the Gateway
correctly deduplicated it, but model protocol compliance failed. D had none of
these violations across its five repetitions.

The final E confirmation must not be hidden behind the successful D matrix:
chief posted the correct assignment, then an additional waiting/progress message
mentioning both experts. The business writes still happened exactly once and the
final count was correct; no sleep or duplicate final reply occurred. This created
five bot messages and nine runs instead of D's four messages and seven runs.
It fails the fixture's one-post diagnostic. Model adherence and unnecessary
mentions remain an optimization target; no semantic message filter or new routing
restriction was added to conceal that behavior. Because both chief posts match
the assignment-candidate predicate, the diagnostic intentionally leaves
expert-level protocol association inconclusive.

## Browser-concurrency calibration: gate remains open

Both matrices completed five unique repetitions of each X02/X03 scenario,
including matching solo controls and the concurrent pair. Missing or failed
solo controls would be unclassifiable; none of these final pairs is unclassifiable.

| Configuration | Canonical classification | Strict diagnostic pairs | Calibration decision |
| --- | --- | --- | --- |
| Parser-only B | 9 clean, 1 interference, 0 unclassifiable | 0/10 pass | Escalate by new ADR |
| Summary-protocol C | 9 clean, 1 interference, 0 unclassifiable | 2/10 pass | Escalate by new ADR |

The B harness originally reported 0/10 because it treated completed `silent`
runs as failures. The uniform scorer corrects only this status semantic while
preserving the original errors and its genuine concurrent max-turn failure.
Future harness runs now accept `succeeded` or `silent`; failed/cancelled/parked
states never pass. C's original harness reports 9/10, identical to re-scoring.
Each configuration separately has observed interference **10%**, with Wilson 95%
interval approximately **1.79–40.42%** under the independent-pair assumption.
The results do not establish a population rate, but both trigger ADR-0004's
predeclared empirical >5% escalation. No result is pooled across versions.

C's failure is repetition 5, X02 concurrent refund run
`run_b8ee96ec1ab949f79dd62ee646cddd71`: the unchanged 300-second deadline expired.
Both solo controls passed. The two refund labels and all three reassignments were
correct; unrelated state, independent targets, screenshot attribution, overlap
and absence of own-tab waits all passed. The refund run had verified its requested
writes around 02:10:39 UTC, then continued inspecting unrelated tickets until it
was killed at 02:13:11. Its peer had already ended around 02:10:30. A recovered
stale ref and later missing-capture warnings therefore do not establish an ongoing
lock conflict. Model over-verification and tool/capture/service latency remain
competing explanations. Operational interference is not proof of lock causation.

No timeout or turn limit was raised and no passing rerun replaces the failed trial.
The required [ADR-0007 escalation](../adr/0007-browser-origin-coordination-calibration.md)
proposes a controlled origin-coordination experiment with explicit waiting,
deadline and takeover semantics. It is proposed, not accepted or implemented.
B3's group and collaboration gates can be recorded as passed, but its dependency
on browser concurrency prevents an overall completed status.

## Turn-budget calibration

Each D group repetition has three human exchanges with bot-message counts
`[2, 1, 1]`. Each of five D X01 exchanges has four bot messages. All 20 successful
exchanges finish without a pause under the existing budget 8. Since reaching the
configured budget pauses a thread, the empirical 95th-percentile count of four
implies a proposed minimum budget of **5**, not 4. This is a small-sample proposal,
not a claim that 95% of arbitrary production conversations will finish.

Keep the production default **8**. Changing it is a separate strategy knob and
needs its own predeclared paired comparison. The additional E confirmation had
five messages, illustrating why the narrow D calibration is not a universal
bound. It is reported separately rather than silently folded into D's K5 sample.
Track production `budget_pause_rate` and recalibrate above 5%, as ADR-0005 requires.
Silent-run counts are recorded; this batch does not measure their token-cost share
and does not claim a cost reduction.

## Other B3 gates and limits

The earlier isolated group UI QA covered three-member creation, simultaneous
running indicators, attributed messages/run links, pause banner, human recovery,
newcomer join and run-to-thread navigation. It used a scripted provider and
separate ephemeral Gateway/UI ports. It was not a real-model browser quality test.
The UI did not change during this follow-up.

Deterministic real-SDK checks exercise relay and turn-budget caps with both thread
alerts and `cap_breached` ledger events, explicit silence without a derivative wake,
and two-run takeover screenshot suppression. T0/T1 routing, coalescing, cursor,
logical-message idempotency and transaction rollback checks remain in the suite.
The complete group K5 matrix is on D; E's context differs by the reviewed routing/cap
qualification and has separate chief/group/X01 confirmation and deterministic checks.
This report does not claim E was subjected to a second group K5 matrix.

B4 (operator authentication and workspace/network isolation), B5
(knowledge/memory, vision and CLI execution), retained-tab cleanup and resource
capacity measurements remain separate. No main application deployment is included.


## Local and container verification

- Final local T0/T1 suite: **1033 tests / 74 files passed**. No real model is called
  by these tests. Backend/acceptance typecheck and Biome pass.
- Web typecheck and production build passed earlier in this follow-up; web source
  has not changed since those checks.
- Final image E: **4 deterministic T2 checks / 3 files passed** in 48.77 seconds
  (`m2-group-limits`, `m2-group-silence`, `m2-takeover`). These use the actual SDK
  and isolated Docker runtime with a scripted upstream, not a real model.
- Pinned-MCP stale-reference test: **1/1 passed** in 7.77 seconds, covering both
  snapshot modes. Old references remain rejected and fresh snapshots work.
- Added calibration integrity tests reject duplicate/incomplete repetitions,
  missing evidence, failed solo controls and timeout controls. Original runtime
  checks and harness errors stay visible beside uniform canonical re-scoring.

## Evidence index

All paths below are under `spikes/m2-business/` in this worktree. Raw evidence is
ignored by Git; the tracked report records the conclusions and limitations.

| Evidence | Directory |
| --- | --- |
| Parser A/B K5 | `work-b3-group-paired-k5-20260923` |
| Summary instruction B/C K5 | `work-b3-summary-protocol-paired-k5-20260923` |
| Same-image role v1/v2 K5 | `work-b3-role-contract-paired-k5-20260923` |
| Group D K5 / E confirmation | `work-b3-group-async-k5-20260923` / `work-b3-group-final-20260923` |
| X01 C control K5 | `work-b3-billing-k5-20260923` |
| X01 D candidate K5 | `work-b3-billing-async-k5-20260923` |
| X01 E confirmation | `work-b3-billing-final-20260923` |
| Chief E confirmation | `work-b3-chief-final-20260923` |
| Browser parser B K5 | `work-b3-tickets-k5-20260923` |
| Browser summary C K5 | `work-b3-tickets-protocol-k5-20260923` |
| X04 C / D | `work-b3-takeover-20260923` / `work-b3-takeover-async-20260923` |
| Injection C | `work-b3-injection-20260923` |
| D deterministic runtime, MCP reference check, web checks | `work-b3-async-runtime-20260923` |
| E deterministic runtime, final local checks and image build | `work-b3-close-runtime-20260923` |

The earlier scripted UI evidence is in `spikes/m2-group-ui/work-v2-20260923`.
Each model runner directory contains source/image/model provenance, raw per-run
traces and original process exit status. `analyze.ts` computes separate canonical,
protocol, interference and budget summaries without rewriting these records.


## Closeout and next dependency

All model series completed, including failed attempts. Aggregate `analysis.json`,
`verification.json` and raw-evidence hashes are in
`work-b3-close-runtime-20260923`; scoring source is code revision `82077cf`.
All test containers exited and were removed by their stack cleanup. The only
remaining container is the pre-existing application `30a40ea896fb`, image
`8a575525c985`, still healthy with its original uptime. Main checkout, application
data, image tag and ports were not changed or restarted.

Code and documentation remain on the isolated branch. The next dependency is the
ADR-0007 browser-coordination investigation and its versioned waiting/deadline
contract, not B4/B5 and not a claim that the lock caused the observed timeout.
B3 remains open until that prerequisite is resolved and revalidated.
