# Evaluation repair plan: outcomes, evidence, and long work

Date: 2026-09-25  
Status: implementation plan; no historical verdict or runtime policy changed

This plan extends the [test strategy](test-strategy-2026-09-20.md),
[measurement protocol](measurement-2026-09-20.md), and
[deskbench oracles](benchmark-2026-09-20.md). It applies first to M2 group and
ticket acceptance, then to longer controlled missions. The six-hour campaign
and its fixed historical verdicts remain as recorded in
[its results](m2-six-hour-soak-results-2026-09-25.md). The
[research synthesis](long-horizon-agent-evaluation-research-2026-09-25.md)
motivates the separation below; it does not establish a universal completion
rate or an implemented product verifier.

## 1. Evidence contract before a trial

Every task version must ship with a fixture authored **before** its runs, kept
outside the bot's workspace. It specifies the initial state and reset receipt,
the instruction the bot sees, permissible state paths, positive outcome
predicates, forbidden effects, required process constraints, budget and timeout,
and the evidence source for each predicate. The fixture also identifies the
scenario, arm, repetition, model route, code/image/config hashes, task and grader
versions, and a stable seed or variant ID. Freeze it for a campaign. Changing a
task, seed, oracle, or grader creates a new version; compare only matching
versions or explicitly regrade retained raw evidence with both versions shown.

The fixture's expected answers and test-only state endpoints stay outside the
agent-visible instruction, browser filesystem, and tool returns. The runner
captures a before snapshot and an after snapshot from the controlled application,
its operation log or durable receipts, and relevant Gateway ledger/thread records.
The grader reads those independent sources after the run. A model reply, run
summary, successful process exit, `thread_post` intent, or raw HTTP request alone
cannot prove a committed effect. Runtime verification in a real deployment may
use ordinary authorized application receipts; privileged test-only state is for
offline acceptance and must not become a production agent capability.

For each check, save `{name, dimension, status, evidenceRefs, reason}` with
`status = pass | fail | unknown`. `evidenceRefs` identify immutable snapshot,
operation, message, run, tool event, or screenshot IDs and their hashes, without
copying secrets into reports. Use `unknown` when the source is absent, truncated,
inaccessible, inconsistent, or cannot attribute an action to a target. A missing
required write in a complete, healthy after snapshot is a **fail**; a missing
after snapshot is **unknown**. An explicit forbidden action in a complete trace
is a **fail**; an incomplete trace cannot establish its absence. An interrupted
trial remains interrupted even if some writes were observed.

## 2. Three verdict dimensions and termination

| Dimension | Pass evidence | Failure example | Source |
| --- | --- | --- | --- |
| Business outcome | All requested durable writes/answers/artifacts, no duplicates, and no unrelated state changes; a read task leaves state unchanged | Required `refund` label absent in complete state; neighboring ticket changed | Controlled app state, operation log, artifact hashes, exact-answer oracle |
| Execution constraints | Every explicitly required approval, allowed-tool rule, ordered handoff, ownership rule, and fixed time/turn budget holds | Browser-only task invokes Bash; required assignment marker absent; 35-turn cap hit | Gateway ledger, thread messages, tool events, clock/turn receipts |
| Diagnostics | Execution-quality measurements with their own named checks; report counts and rates without treating recovered errors as lost business outcomes | Stale reference rejected and later recovered; unnecessary search after final write | Tool-event trace, usage, timing, screenshots |

Each dimension is `fail` if any check fails, `pass` if all required checks pass,
and `unknown` otherwise. Optional diagnostics are labeled as such and cannot
make an outcome pass. Store the existing canonical and strict booleans and named
checks unchanged beside the new dimensions. A new dimension is a new reading of
evidence, never a silent rewrite of a historical acceptance verdict. Do not
calculate a historical business-outcome numerator from a summary that lacks raw
per-check evidence; show it as unknown until the retained evidence is regraded.

Record terminal reason separately: `verified_success`, `model_declared_done`,
`blocked`, `budget_exhausted`, `runtime_error`, `cancelled`, or `unknown`.
`verified_success` requires a passing independent outcome and required
constraints. A model saying “done” while no matching receipt exists is
`model_declared_done`, even if the SDK returns `succeeded`. A run may have
business outcome `pass` and execution constraints `fail`, such as completing both
writes but exhausting its turn budget before ending. Preserve both facts.

The current M2 failures illustrate the split:

* Chief slots 9 and 17: no tool call or expert run supports the model's claim
  that it delegated. Delegation and the dependent business outcome fail; the
  claimed completion is unsupported. A complete ledger is required to call the
  delegation absent.
* Chief slot 15: expert replies and `CHIEF_TOTAL:96` are present. The missing
  `CHIEF_ASSIGN` marker is a protocol constraint failure, not evidence that no
  delegation happened. Separately check attributable `thread_post`/expert runs.
* X02 slot 16: the solo arm missed the `refund` write; its business outcome
  fails. The concurrent arm had the requested writes, but exceeded 35 turns;
  business outcome and budget/termination constraint must be reported separately.
* X03 slot 6: a lock-wait message followed `browser_tabs(close,index:2)`. Without
  an index-to-stable-target and ownership mapping at that moment, wrong-own-tab
  blocking is **unknown**. Preserve the historical oracle failure; do not infer
  a browser-lock root cause from the message alone.
* Thirty-four stale-reference errors in the ticket campaign are tool **events**,
  not 34 failed tasks. A recovered error increases recovery overhead; an
  unrecovered error may also cause an outcome or constraint failure. A forbidden
  non-browser call remains a constraint failure even when the final state is right.

## 3. Grader specification and validation

Keep deterministic graders in a test-only package/process outside the bot
workspace. A grader returns check-level evidence and one of the three statuses;
it never trusts the bot's self report as the sole source. Define exact comparison
rules for state paths, allowed incidental changes, duplicates, answer
normalization, ordered operations, approval decisions, and time/turn endpoints.
Avoid mandating a single tool sequence when multiple paths produce the intended
state. If a workflow explicitly requires a handoff or a tool restriction, grade
that as a constraint with ledger evidence. For subjective artifacts, a separate
rubric reviewer may help, but version and calibrate it against human-labeled
controls; retain deterministic checks for available durable state.

Before a new grader gates a model run, execute at least these fixed controls:

| Control | Expected verdict |
| --- | --- |
| Reference solution from seed, including all required writes and no collateral change | Business pass |
| Missing one required write; duplicate effect; unrelated destructive edit | Business fail for each mutation |
| Correct state with missing required marker, forbidden tool, or exceeded budget | Business pass, constraint fail |
| Correct state after a recoverable tool error | Business pass; diagnostic error/recovery recorded |
| Model “done” with no tool call or durable change | Unsupported claim; no verified success |
| Missing after snapshot, truncated trace, or missing tab ownership map | Relevant check unknown, never inferred pass |
| Peer-tab close blocked and own-tab close allowed, each with stable target IDs | Correct lock attribution |

Add mutation tests that remove or swap one receipt at a time, and a negative
control that deliberately changes a non-allowed state path. The reference case
must pass and each mutation must fail the intended check only. Run controls on
every grader change; version the grader and keep its failures distinct from
agent failures. If a grader crashes or its evidence is incomplete, the trial is
ungraded/unknown, not an agent failure. Cross-check a sample of raw traces and
grader outputs by a reviewer before using new metrics for a decision.

## 4. Stop and completion evidence

The bot should be able to stop promptly after the last required effect or state
that it is blocked. Measure `finish_latency` from the last verified required
effect to the terminal event, post-completion tool calls, extra model turns,
and token/cost overhead. Compare those as diagnostics; a fixed turn or wall-clock
limit remains a constraint. Do not raise a limit merely to turn a failure green.

A future bounded completion check can inspect independent receipts at a proposed
stop. It returns `satisfied`, `unsatisfied`, or `unknown`, with evidence IDs and a
small remaining-work hint. One bounded continuation may be offered when
unsatisfied, within the predeclared budget. `unknown` must not trigger an
unbounded loop or be called success. This is a proposed product behavior, not a
change to the pinned SDK or the thin Gateway. An implementation that changes
stop hooks, prompts, budgets, or agent behavior is a strategy change and follows
the paired protocol in measurement §4–5; an architectural deviation needs an ADR.

For browser ownership diagnosis, record on each relevant tool call the run ID,
workspace, selected tab/window stable target ID, target ID's owner at action
time, action, requested index as displayed to the model, lock decision and
reason, and before/after target-list version. A screenshot records its target ID,
run ID, and capture time. A tab index alone is not identity. Test simultaneous
creation, index shifts, close, popup, and peer targeting. The ownership grader
may mark a wrong-own-tab block only when these records show the requested stable
target belonged to that run when the lock decided. If mapping is unavailable,
mark the new attribution check unknown and retain the raw wait event.

## 5. Three distinct campaigns

| Campaign | Unit and setup | What it establishes | Minimum report |
| --- | --- | --- | --- |
| Repeated task reliability | A fixed scenario/arm attempted K times with reset seed and fresh stack where specified; include all scheduled attempts | Per-scenario chance and consistency under that fixture distribution | Pass/fail/unknown by dimension per attempt; pass^k, point estimate and interval by scenario/bucket; all missing, skipped, interrupted attempts |
| Coherent long mission | One stateful mission with dependent phases, no reset between phases; outputs of discovery determine later export/import/reconciliation; deliberate pause/resume variant | Ability to maintain and complete a genuinely dependent workflow under fixed budgets | Whole-mission outcome and per-phase predicates, artifacts/receipts, constraints, terminal reason, turns/time/cost and continuity evidence |
| Continuous workspace endurance | One workspace/browser/profile/container kept alive throughout the declared window; scheduled workloads and takeover/restart fault variants recorded | Session/resource durability and leakage under continuous lifetime | Uptime, scheduled/executed jobs, state continuity, p95/peak resources, restart/recovery and observer gaps |

The 2026-09-25 six-hour campaign is the first kind: 18 scheduled slots used fresh
workspaces. Its 13/18 suite passes, 33/36 foundation cases, 16/18 canonical
ticket scenarios, and 2/18 strictly clean ticket scenarios are different
denominators and must remain labeled. It is neither a six-hour coherent task nor
a six-hour single-workspace endurance result. A future long mission can use the
controlled Galaxy Ops Console plus a second controlled application. Preauthor
an eligible-record predicate, export checksum, import validation failure,
recovery action, exact final records, duplicate check, and forbidden changes;
later stages depend on the actual export. Keep evaluator-only data inaccessible
to the bot. Do not claim a METR-style human-time horizon without human expert
completion baselines on a suitable task distribution.

## 6. Aggregation, comparison, and acceptance

An **attempt** is one scheduled execution of one versioned scenario and arm;
an **arm** is solo or concurrent; a **suite** may contain multiple attempts;
an **event** is one tool/error/ledger occurrence. Never mix their numerators.
Use the planned attempt count as the primary denominator for campaign completion:
report pass, fail, unknown, skipped, and interrupted separately. An observed-only
success rate may be shown with its smaller denominator and label. For a paired
solo/concurrent case, preserve both arm verdicts and define pair pass as both
passing the selected dimension. An unknown arm makes pair status unknown unless
the other arm already fails. `pass^k` means every one of K predeclared attempts
for a scenario passed; a missing or unknown attempt does not count as success.
Do not treat correlated repetitions or 18 slots as independent production
sampling. Include confidence intervals with their clustering and limits stated.

For strategy, model, or budget changes, follow measurement §4–5: same task and
grader versions, fixed seed/variant schedule, served model and gateway route,
images/code/config hashes, approval rules, SOUL/MEMORY snapshot, browser mode,
turn and wall-clock budgets; change one knob, alternate A/B in paired attempts,
and retain all failures. Report paired outcome differences and intervals by
duration bucket, constraints and diagnostics separately, plus cost/time and
behavioral fingerprint. The existing four long deskbench tasks are a smoke set,
not a powered regression verdict. A new long-mission set needs enough varied,
prevalidated tasks and human baselines before making general horizon claims.

Implementation is staged. The first offline scoring/reporting repair may add
separate dimensions to existing M2 rows and count only dimensions backed by
their named checks. Rows that lack checks remain unknown. Its acceptance gate is:
unchanged historical canonical and strict fields; missing raw checks and tab
provenance shown as unknown; named dimensions reported with scheduled case,
scenario-pair and suite denominators kept separate from event counts; and
positive/negative unit controls for the cases actually scored. The task report
must state which rows are covered. Passing this gate does not establish a new
business-outcome count for the retained six-hour campaign.

The full grader/evidence implementation is accepted only when offline tests
show: (1) all seven controls in §3; (2) every planned M2 row has versioned,
preauthored checks and evidence refs; (3) grader failure, missing after state,
truncated trace and missing tab mapping are unknown rather than agent failure;
(4) stable target attribution resolves own-tab and peer-tab controls; and (5)
regrading retained slot 15, slot 16, and slot 6 raw evidence yields the
distinctions above while preserving historical verdicts. Run affected offline
tests, typecheck, and lint. The bounded completion behavior and three new
campaign types in §§4–5 remain proposals until separately implemented and
measured. Live model trials, deployment, and reliability claims need their own
recorded results.
