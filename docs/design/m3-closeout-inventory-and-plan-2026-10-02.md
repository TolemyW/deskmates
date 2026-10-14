# M3 inventory and parallel closeout plan

Date: 2026-10-02 (Asia/Taipei). Planned work day: 2026-10-03.
Source baseline: local main `1109ec7`; working tree clean before this document.
Status: current inventory and proposed execution plan. This records the owner's channel scope amendment below; it does not authorize deployment or declare
milestone acceptance.
The owner requested an inventory and plan for parallel M3 closeout tomorrow.

## Scope and evidence rules

The effective roadmap is design v0.3 section 8 plus C41/C42: database connector,
scenario images, WhatsApp channel (owner amendment, 2026-10-02), cost alerts,
and context/memory. Desktop VM was
removed on 2026-09-29. Telegram is not an additional closeout gate merely because
it appears in the architecture diagram. The later interaction batch and M2
repairs must be tracked separately even where M3 relies on them.

Implementation, deterministic tests, container acceptance, model behavior and
deployed release are separate states. A Proposed ADR can have implementation;
its status needs reconciliation rather than an assumption that no code exists.
The old context/memory plan's present-tense descriptions are historical, not a
current inventory. Existing passing demonstrations are not paired strategy
evidence or estimates of reliability.

This assessment reads repository source and retained results. No new tests,
model calls, remote inspection or deployment were performed. Main is newer than
the last recorded stable v0.2.18 deployment; do not assume all current fixes are
already deployed.

## Owner amendment: WhatsApp replaces Slack (2026-10-02)

The owner replaced the M3 Slack channel with WhatsApp and deferred Slack.
WhatsApp is the new channel deliverable, not an already implemented adapter.
Select and verify its supported connection mechanism, account prerequisites,
inbound/outbound constraints and approval delivery in the channel ADR before
implementation; no provider/library choice is implied by this plan.

Slack may be reconsidered only if it can present each bot's overall work record,
rather than merely forward chat replies. The future proposal should show tasks,
run/attempt status, delegation, approvals, outcomes and artifact links with
traceability to the Gateway ledger. This is a product requirement to design, not
permission to export raw secrets, tool results or thinking blocks. The exact
record coverage and presentation remain to be specified. Existing Slack SaaS
integration code is separate and is not removed by this channel decision.

## Current inventory

Priority P0 means milestone gate or a correctness prerequisite; P1 means an
existing user-flow gap to finish if included in the release; P2 means separate
follow-on work. These are planning priorities, not defect severity ratings.

| ID | Work and origin | Current evidence | Remaining closeout work | Priority / proposed lane |
| --- | --- | --- | --- | --- |
| M3-01 | Database connector, original M3 | ADR-0012 typed execution/receipts, connector-postgres and Gateway path exist. v0.2.18 live VendorDB/PG calls completed. | Reconcile ADR status; verify validation, approval, idempotency, receipts, credentials and workspace boundary on candidate. Bind report claims/counts to receipt steps. Document procedural adapter limits separately from engine results. | P0 / A |
| M3-02 | Scenario images and three domain flows, original M3 | Portable scenario configuration exists; shared-workspace flow passed once; VendorDB workflow completed with report-quality defects. | Inventory required dependencies/images; pin reproducible scenario environment and images. Add/finish one genuine domain E2E and oracle for product testing, data development and quant. | P0 / A + D |
| M3-03 | WhatsApp chat channel, replaces original Slack scope | packages/channels remains a stub; no WhatsApp adapter exists. Slack channel is deferred. | Channel ADR and verification table before implementation: workspace/thread mapping, sender identity, deduplication, mentions, delivery and approval semantics. Verify WhatsApp connection/account prerequisites and supported behavior; implement bounded adapter and deterministic tests, then run a real channel journey. | P0 / B |
| M3-04 | Cost alerts, original M3 | Token pricing, cost API/UI and unknown-usage display exist. No completed alert acceptance receipt identified. | Settle threshold/window/reset/deduplication and notification contract; preserve unknown usage and attempt totals. Implement/test threshold alert. Enforced spending budgets and external notification delivery are separate scope unless explicitly adopted. | P0 / B |
| M3-05 | Context observability, formally added 2026-09-29 | Per-turn/context API and UI, compaction reporting paths, compare/replay tools exist. | Verify actual SDK shapes and ledger coverage on candidate; establish prompt snapshot/cache/window findings with retained evidence. Missing metrics remain unknown. | P0 / C |
| M3-06 | Scoped learned memory, formally added 2026-09-29 | ADR-0011 accepted; stores, search, immutable versions, trust filtering, task closure, consolidation and inspection UI exist. T2 boundary test exists. | Verify full lifecycle, restart/quiet-window/cooldown, confirmation, source trust, forgetting and rule protection. Run scoped memory campaign and the required paired strategy evaluation. | P0 / C |
| M3-07 | Context bounds and strategy experiments, formally added 2026-09-29 | Measurement plan exists; no complete acceptance receipt for adopted masking/offload/rotation knobs identified. | Measure before adopting. One knob per paired experiment, duration buckets and safety gates. Explicitly account for exports/history and task-note starvation. If deferred, record an owner-approved roadmap amendment; do not silently mark full M3 complete. | P0 scope decision / C |
| UX-01 | Canonical SOUL/offline Bot management, added interaction work | Config import, optimistic versions, run delivery/audit and management UI implemented. | Verify populated DB upgrade, concurrent import, offline edits, parked-session protection, exact effective files and real SDK restoration. Dedicated bounded capability test remains absent. | P0 prerequisite; extra test workflow P1 / C + D |
| UX-02 | Turn exhaustion and delegation outcomes, added reliability work | ADR-0016 implementation, attempt accounting and notices exist. Real duplicate SDK-exit regression was corrected on main. | Candidate-image continuation, stop, expiry, two-continuation cap, restart/race checks and delegator notification. Retain M2 chief/silent-result regressions. No arbitrary mid-run steering feature is included. | P0 prerequisite / D |
| UX-03 | Run supervision, added interaction work | Status/context/attempt views and inclusion receipts implemented. | Browser verification of failed/silent/parked/queued states, stale response races, missing usage and distinction between process success and task delivery. | P1 / D |
| UX-04 | Schedules, added interaction work | Edit, timezone and next-fire UI implemented. | Verify real firing/overlap/edit/remove; recent schedule results absent. Stable identities, pause/run-now and per-schedule timezones are additional backend scope. | P1 / D |
| UX-05 | Deliverable downloads/previews, added interaction work | Authenticated downloads and inert bounded text preview implemented. | Verify real container files and stopped/missing/binary/UTF-8/size errors. Contract remains current bytes, ASCII path policy, 1 MiB download and 256 KiB preview; broader paths and immutable artifacts are follow-on work. | P1 / D |
| EXT-01 | SaaS integration runtime/onboarding, added extension | ADR-0013/runtime/API/UI exist; local spike does not establish live OAuth/provider readiness. | Existing API-key form/provider values, test feedback and receipts remain incomplete; live app grants/refresh/provider-egress prerequisites required. Fix only blockers to adopted flows; additional providers stay separate. | P1 if used / A |
| EXT-02 | Skills lifecycle, added proposal | ADR-0015 Proposed; no completed lifecycle implementation identified. | Installation/scanning/version pinning/assignment/SDK-use proof and authoring evidence. | P2, proposed follow-on |
| EXT-03 | Shared work board/task entity | Spike only; delegation runs are not a full task/dependency/artifact model. | New task contract and ADR before production implementation. | P2, proposed follow-on |
| EXP-01 | Stock completion controller | Pilots 6/7 accepted for the bounded instance with independent operator audit and two repair cycles each. | Keep supervised instance evidence; do not promote to autonomous/default behavior or factor-backtest acceptance. | Separate experiment |
| OPS-01 | Releases and local work consolidation | v0.2.18 release passed recorded T0/T1/T2; Oct 2 consolidation records 2,344 T0/T1 cases. | Re-run gates on integrated candidate, then T3; tag/deploy only under release policy. Historical QA/portability results do not validate current production behavior. | Integration owner |
| OUT-01 | Desktop VM | Explicitly removed by C41. | None for M3. | Unscheduled |

## Domain acceptance must match the roadmap

Benchmark section 7 describes broader domain suites; the milestone roadmap
requires one end-to-end flow for each of the three scenarios. A minimal milestone
slice still needs the actual domain's artifact and oracle:

| Domain | Proposed minimal closeout slice | What existing evidence does not establish |
| --- | --- | --- |
| Product testing | Bot turns a concrete application test requirement into an executable test, runs it on the separate app under test, and supplies a correct result/artifact. | Shared workspace ops-brief is collaboration evidence, not automated product testing. |
| Data platform | Bot executes a seeded SQL or import task through the production connector; oracle compares reference rows/counts/checksums and binds report claims to receipts. | Compatibility research/report generation alone does not establish all data-development tasks. |
| Quant research | Reproduce one preselected known factor/backtest on frozen data; numerical tolerance and artifact provenance fixed before execution. | Stock filings/recommendation and hypothetical rules with backtestStatus not-run are not a factor backtest. |

Do not claim the full 20/50/3 benchmark suites from these minimal slices. Freeze
fixtures, tasks, model settings, oracle and images before calls. Check golden-site
separation and ensure answer keys are not available in the bot workspace.

## Tomorrow's parallel work

Use four work streams plus an integration responsibility. These are assignment
templates for tomorrow, not chats or agents created by this planning task.

| Lane | Assignment | Primary ownership | Required handoff |
| --- | --- | --- | --- |
| A: connector and domains | Finish M3-01; audit image prerequisites and data-domain oracle; fix adopted integration onboarding blockers. | connector-postgres, Gateway connector/integration modules, data fixtures | Contract support matrix, targeted tests, pinned data scenario and receipt-grounded oracle; exact live prerequisites. |
| B: missing M3 features | Implement WhatsApp channel and cost alerts after their decisions are recorded. Treat these as new development, not QA-only cleanup. | channels, narrowly assigned Gateway channel/alert modules and related UI | ADR/verification mapping, deterministic tests, WhatsApp account/connection setup requirements, real journey receipt or explicit blocked gate. |
| C: memory and context | Verify M3-05/06 and canonical delivery; complete measurement receipts; propose explicit disposition of M3-07 based on feasibility/evidence. | Gateway memory, sidecar context/canonical delivery, evals memory/context | Lifecycle/security receipts, actual usage/compaction findings, paired results or explicit unvalidated status; no unrelated strategy knobs. |
| D: interaction and acceptance | Verify UX-02/03/04/05, retain M2 regressions, own product/quant minimal scenario tests and final cross-lane QA. | acceptance, focused Web interactions, assigned scenario fixtures | Upgrade/browser/continuation results and domain oracles; independently inspect deliverables rather than accepting markers alone. |
| Integration owner | Freeze scope/contracts, reconcile shared edits, pin candidate, run full gates and compile final closeout matrix. | shared contracts/migrations/root config/release manifest | One revision/image set, gate results and unresolved item disposition; milestone status and release status separately. |

Gateway contracts, API registration, migrations, sidecar start-run/context code
and shared Web screens overlap. The integration owner allocates numbered
migrations and merges shared changes; lanes do not independently edit the same
contract or screen. Use isolated branches/worktrees with a recorded common base.
Each lane reads applicable package README and architecture/ADR sections first.

### Sequence

1. **Kickoff:** choose full-scope M3 versus a specifically amended reduced scope.
   Default remains full roadmap; this document retains WhatsApp, cost alerts
   or measured context requirements. Check WhatsApp connection/account prerequisites, database and
   frozen quant data before assigning dependent implementation. Record missing
   prerequisites immediately; continue independent work.
2. **Contract freeze:** settle channel external-post risk, alert delivery,
   minimal domain oracles and any context deferral. ADR changes precede changes
   to architectural rules. Shared contracts/migrations land once.
3. **Parallel development:** each lane completes code and affected tests/typecheck
   and reports implementation gaps separately from failed/skipped acceptance.
   Keep design/ADR changes in their own commits if commits are requested.
4. **Candidate integration:** pin one commit and image digests. Full typecheck,
   lint, T0/T1, Web checks/build, populated-database upgrade and full T2. An edit
   after a gate invalidates the affected evidence and requires the appropriate
   rerun; do not combine incompatible branch/image receipts.
5. **Real acceptance:** use an isolated Testbox environment and quiet window.
   Schedule heavy SDK/model campaigns through the host lock, not several
   simultaneous heavy jobs. Pair strategy arms under fixed settings; record
   logical/physical attempts, input/output/cache usage, missing coverage and
   every retained failure. Apply the relevant authorization to each campaign;
   old six-case recovery authorization is not a blanket new-campaign scope.
6. **Closeout:** produce the matrix below, update stale ADR/roadmap/test references,
   and decide release only after gates. Do not touch stable test data or deploy a
   dirty tree. Deployment, if requested, follows the existing tagged-release and
   backup policy.

Parallel development can compress implementation time. WhatsApp account/connection provisioning,
domain fixtures and statistically valid paired evidence can exceed one day;
tomorrow's success must not be defined by relabeling these unfinished gates.

## Definition of done and result receipt

Full M3 closes only when M3-01 through M3-07 are satisfied under the effective
roadmap, the adopted feature/user-flow prerequisites pass, and the three domain
flows have executable passing T3 oracles on the candidate. If scope changes,
record the owner's decision and update the canonical roadmap/test mapping;
call the result acceptance of that amended scope. M2 retained failures and
deferred S09/S10 stay separately visible and are not erased by M3 results.

Each lane and the final report use this row format:

| ID | Accepted scope / commit | Implemented | T0/T1 | T2 | T3/live-provider | Paired strategy evidence | Image/config/receipt | Remaining blocker and next action |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Example | Exact decision and revision | yes / partial / no | pass / fail / not run | pass / fail / prerequisite missing | pass / fail / not run | pass / fail / unvalidated / not applicable | Exact references | Concrete owner/action; unknown outcomes remain unknown |

A passing unit suite is not milestone acceptance. A model reviewer PASS, ready
marker or file-existence check is not sufficient for material factual/numerical
claims. Missing live credentials, skipped tests and absent usage are recorded,
not treated as success or zero.

## Evidence references

- [Architecture scope](design-cogbot-thin-core-v0.3-2026-09-20.md), C41/C42 and section 8.
- [Domain suites](benchmark-2026-09-20.md), section 7.
- [Original context/memory plan](m3-context-and-memory-plan-2026-09-29.md).
- [Interaction scope](interaction-optimization-scope-2026-09-30.md) and [implementation handoff](../runbooks/interaction-optimization-test-handoff-2026-09-30.md).
- [v0.2.18 release/scenario results](release-validation-2026-10-01.md).
- [SDK exhaustion regression](sdk-turn-exit-regression-2026-10-01.md).
- [Supervised stock pilots](stock-supervisor-results-2026-10-01.md).
- [Main consolidation and current deterministic test receipt](worktree-consolidation-results-2026-10-02.md).
- ADRs [0011](../adr/0011-learned-memory-scopes.md), [0012](../adr/0012-connector-execution-contract.md), [0013](../adr/0013-saas-integrations-through-an-integration-runtime.md), [0014](../adr/0014-workspace-file-download.md), [0015](../adr/0015-skills-bots-learn-and-humans-install.md), [0016](../adr/0016-turn-budget-exhaustion-parks-for-the-delegator.md).

The test-strategy document still lists Desktop VM under M3. Reconcile that stale
reference with C41 when updating milestone acceptance; it is not an active gate.
