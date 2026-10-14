# Stock completion controller: retained pilots

Date: 2026-10-01. Status: the original bounded task is accepted in pilot 6 and
one prospectively declared unchanged repetition, pilot 7. Both required an
independent operator's evidence review and two targeted repair cycles. This
establishes a working supervised method for this instance, not universal
completion, model-only autonomy or production-default readiness. All earlier
failed candidates remain failures in the history below.

The tested configuration is GLM-5.3 with adaptive thinking and high effort;
thread budget 16, 18 turns / 300 seconds per physical attempt, concurrency 3,
8192 MiB and owner-v1. The operational recipe is
[`reviewer-guide.md`](../../spikes/stock-supervisor-20261001/reviewer-guide.md).
Stable v0.2.18 was not changed. This is not a DeepSeek validation result.

The owner asked for a suitable configuration or automation that completes the
task, with every adjustment based on real examples. The earlier budget-only
pilot failed at both 8 and 16; see
[`stock-budget-pilot-results-2026-10-01.md`](stock-budget-pilot-results-2026-10-01.md).

## Framework prerequisite

A real 18-turn stock run exposed an ADR-0016 implementation error: a duplicate
SDK subprocess-exit exception overwrote its structured exhaustion result. The
scoped correction and original/fixed real-model regression passed; see
[`sdk-turn-exit-regression-2026-10-01.md`](sdk-turn-exit-regression-2026-10-01.md).
All controller pilots use corrected image
`sha256:9f33e37e233d321fc3b03007c83d792d8b4119a250d92a97a39524ec6325ed33`.
Stable remains on v0.2.18 and has not been upgraded.

## Initial fixed setup and automation (v1; later revisions below)

The original four-role scenario, source pack, GLM-5.3 and bot prompts remain
unchanged. Thread budget 16, 18 turns / 300 seconds per physical attempt,
concurrency 3, memory 8192 MiB and owner-v1 routing stay fixed.

The test operator first lets the original scenario runner finish or block, saving
its result. It then acts on the same workspace through authenticated operator
APIs. It may request missing files, corrections, or final risk review after all
runs are quiescent, at most six messages. Submissions are reserved before POST;
unknown outcomes are never retried automatically. The overall controller has a
30-minute observation ceiling and an 80-logical-run ceiling.

SDK continuations use the existing same-run endpoint, at most two per logical
run and four controller decisions overall, conditional on successful read,
write or browser tool work in that attempt. This is a minimum progress signal,
not proof that every call was useful. The controller never approves external
side effects and stops for external approvals or human browser holds.

The artifact oracle independently checks schema, original date/tickers, finite
allocations/cash/caps, rules/sources and `backtestStatus: not-run`. Final risk review
must name SHA256 hashes of both final files, report its required checks, and have
no blocking findings. Any later file edit invalidates the review. All four roles
and the lead's completion marker are required. Its success label is deliberately
`artifact-pass-awaiting-manual-audit`: the campaign's independent audit must still
verify the rules and claims. A review model is not a ground-truth oracle.

## Pilot 1 — workflow complete, independent quality failed

Policy: `stock-completion-v1`. Started 09:33:36 UTC, finished 09:44:56 UTC,
approximately 680 seconds including setup and cleanup. There were 13 logical
runs (6 silent, 7 succeeded), 19 bot messages, four controller messages and zero
controller SDK continuations. All 13 runs have recorded usage.

The original flow wrote both final files and emitted `STOCK_REPORT_READY`, but
its JSON lacked the required finite top-level cash weight. The controller's
first request corrected the structure. Its independent risk-review request then
found a material contradiction: drawdown cuts were undone by the drift and
monthly rebalance targets. A repair request added explicit reduced-target
precedence, and a second review returned PASS tied to the resulting file hashes.

Final hashes:

- Report: `212c6e42ab4d15b1d1191c014e1a93f5b57097366ceae4e4c31c99fc9c8fca86`.
- Strategy: `66b8de491957df684969b4a3d453536d8d798c7b9bfa653f4c27f182d26983f5`.

Independent inspection still rejected the result:

1. `entryRule.orderSubstitution` sizes shares using the execution day's closing
   price, while `rebalance.decisionTime` and the backtest execute at that day's
   earlier open. That price is future information at the stated fill time.
2. `riskLimits.drawdownReview.priceDataSubstitution` substitutes entry-cost or
   last-execution marks for current market NAV. Those stale marks cannot observe
   intervening market losses. Missing current prices must leave this control
   blocked/unknown; cost-basis NAV does not solve the missing-data problem.

These failures were not found by the model's PASS verdict. Both raw verdict and
manual rejection are retained. The instance is not a fully successful task.

Tokens: 194,197 input; 66,924 output; 3,473,408 cache-read; 0 cache-create.
No usage is missing. Exact owned workspace
`ws_cca2fc8266ab486f8b40b0dca139085f` was destroyed; its container query returned
none. Full ledgers and evidence remain, and no stable resources were selected.

Compact audit: [`pilot-1-summary.json`](../../spikes/stock-supervisor-20261001/pilot-1-summary.json).

## Pilot 2 — workflow complete, independent quality failed

Policy: `stock-completion-v2`, frozen before dispatch. It changes the controller's
quality contract and associated feedback in response to the two concrete
counterexamples above. All task/model/runtime settings remain fixed.

The final strategy must include an execution contract: prior-close decision,
next-open fill, quantity pricing from known decision data or actual fill data,
mark-to-market NAV, blocked price-dependent actions when prices are missing,
no active drawdown check on absent marks, and risk exits before old entry gates.
Two additional final-review checks compare those fields with all actual rule
text and backtest requirements; merely adding metadata is not acceptance.

Controller/oracle checks: nine unit tests passed, including stale hash rejection,
allocation failure despite a reviewer PASS, missing checks, unknown POST outcome,
external-approval blocking, no-progress continuation rejection, and invalid
price chronology/cost-basis NAV contracts. Spike TypeScript check passed.

Host campaign root:
`/home/owner/agent_workspace/deskmates-reusable-stock-supervisor-20261001`.
Pilot 2 lives in `stock-pilot-2`. It started 09:48:58 UTC and finished 10:06:24 UTC
(1045.62 seconds). There were 18 logical runs (8 silent, 10 succeeded), 21 bot
messages, four operator messages and zero controller SDK continuations. The
original conversation hit its routing cap; the controller repaired the same
task rather than resubmitting it in a fresh workspace.

The first repair supplied the execution contract. Risk review then rejected
three real contradictions: immediate intra-month redistribution versus holding
cash; monthly rebalancing undoing the drawdown reduction; and the report's
negative-growth exit condition missing from the strategy. A second repair
addressed those findings. The final model reviewer returned PASS for both exact
files, and the structural oracle also passed.

Independent final inspection still rejected the output:

1. `strategy.json:22` fixes quantities at the prior close and requires next-open
   fills at prevailing prices without resizing. A synthetic all-cash portfolio
   of 100 with three 0.30 weights and prior prices of 1 orders 30 shares each.
   Opening prices of 1.20 cost 108 before fees, leaving cash -8 despite
   `maxLeverage: 1` and `minCashWeight: 0.10`. A funded execution/rejection policy
   is missing; checking target weights alone missed this counterexample.
2. `investment-report.md:113` infers materially lower underlying revenue growth
   from tariff refunds increasing gross margin and EPS. The retained primary
   browser result supports those margin/EPS effects, not an effect on revenue
   growth. This is an unsupported cross-metric inference.
3. `investment-report.md:44` says every exit trigger takes a position to zero.
   The JSON instead explicitly specifies a one-third cut for drawdown and a
   trim to 0.35 for overweight drift. The two deliverables contradict each other.
4. The report calls the target allocation a realized allocation and classifies
   price-dependent trading/cap checks as executable on filings alone. No prices,
   holdings or fills were supplied. Eligibility and hypothetical target arithmetic
   are available; realized holdings and execution are not established.

These findings were not fed into the frozen v2 policy mid-run. Its original
PASS, failed independent audit and all intermediate snapshots remain intact.
The synthetic price gap is a rule counterexample, not historical market data or
a performance backtest.

Final hashes:

- Report: `0eedac6388fd5a42e3ef820e76be9c47ba56f01c3e73ec1e739979bdcd0fd0e7`.
- Strategy: `8cf8dcf38f7c17fb64746490f7cededbe70e03dfa15d687d704f993b6eb0cb66`.

Tokens: 287,895 input; 100,274 output; 5,015,040 cache-read; 0 cache-create.
All 18 runs have usage. Exact workspace
`ws_6e7f1c18b334456f98e9b8db4fd735da` has no remaining containers or workspace
network, and all three recorded profile/work/home volumes are absent. Stable
was untouched. Compact audit:
[`pilot-2-summary.json`](../../spikes/stock-supervisor-20261001/pilot-2-summary.json).

The prelaunch v1 and v2 archives/inventories and each controller snapshot remain
on the host. V2 archive SHA256:
`409ddb2d9823d56b3dfcb68daafac6b2b2b9887224379680da654f27348890dd`.
All 14 transferred regular files matched the inventory. The original v1 policy
is also preserved under `spikes/stock-supervisor-20261001/policies/v1/`.

## Decision from these instances

Increasing the thread budget alone did not complete the task. The bounded
controller completed the artifact workflow in both pilots and repaired several
concrete defects, but neither pilot met independent quality acceptance. Keeping
the same review model and adding checklist fields did not reliably prevent
contradictory rules or unsupported conclusions. No production-default change or
successful-repetition claim follows from these runs.

Any next policy must address the retained counterexamples before another real
trial: evaluate funded fills and fees as state transitions, compare report
actions against the strategy, separate target/specification from observed
holdings, and require evidence for material inferences rather than only numeric
source citations. Freeze that policy before dispatch and retain these failures.
The resulting v3 policy and its first reserved trial are recorded below.

## Pilot 3 — execution checks pass, independent boundary audit fails

Freeze `stock-completion-v3` before dispatch, retaining v2 under `policies/v2/`
and in its original host archive. Task, role prompts, source pack, model and
runtime budgets are unchanged. The quality contract now asks the strategist
for a pure Python transition implementation alongside the original two files;
this does not replace the original research/recommendation deliverable.

The fixed verifier runs candidate code only in the owned bot workspace. It
computes its own cash ledger using quantities, opening prices, fees and slippage;
checks caps and cash constraints; and exercises normal funding, uniform and
asymmetric opening gaps, larger fees, missing held prices, future-close input
independence, issuer exit and persistent drawdown holds. Feasible cases must
allocate to the declared nontrivial stock targets, preventing an all-cash or
blanket-blocking shortcut. This uses an explicitly disclosed funded fractional
simulation, not a promise about real market-on-open order fills.

Controller-generated results and the final risk review bind report, JSON and
implementation hashes. The reviewer additionally checks material inferences and
cross-file rules against actual sources/implementation. Independent campaign
audit still determines quality acceptance: eight synthetic cases alone cannot
prove general strategy correctness, source reasoning or investment performance.

Before dispatch, five verifier tests passed using only an authored reference
fixture and deliberately broken variants (unfunded prior-close quantities,
future-input dependency, lost risk hold and missing-price position erasure).
Ten controller/oracle unit tests and the spike TypeScript check passed.

The 15-file explicit transfer inventory verified on Testbox. V3 archive SHA256:
`9f7305188def273587f38fb7e6d1ef99ad0c40498c0ee3c7fc99e96e8a4a0bde`.
The one reserved `stock-pilot-3` launcher is PID `2065779`, confirmed live just
after dispatch. The experiment receipt confirms GLM-5.3, the same corrected
workspace image, thread budget 16, 18 turns/300 seconds, concurrency 3, 8192 MiB,
owner-v1 and the unchanged scenario hash. This exact process was observed until
it finished; no replacement invocation was submitted.

At the first quiescent v3 snapshot, the original risk bot reported PASS after
reproducing the author's self-tests and adding its own probes. The fixed
controller verifier nevertheless failed three of eight cases: normal funded
rebalance, uniform +20% opening gap and asymmetric opening gaps. All three had
`cash ledger does not reconcile fills, fees and slippage`; the other five cases
passed. Inspection locates the mismatch: the implementation charges percentage
commission on pre-slippage notional, while its report/JSON/contract require
commission on actual fill notional. The controller's first repair request was
submitted once on the same task. This is a retained intermediate failure, not
a final result or an efficacy claim. Snapshot: `stock-pilot-3/scenario-results/
us-stocks/supervisor/phase-0/` on the campaign host.

A sixth local verifier unit regression now reproduces this commission-base
mismatch with an authored fixture mutation and confirms rejection. All six
verifier tests pass. This adds evidence without changing the frozen verifier,
controller, contract or running pilot; no replacement invocation was submitted.

At `phase-1`, all eight fixed execution cases passed. Before reaching that state,
two strategist repair runs hit the existing 300-second deadline. The first saved
no repair; the second saved code and JSON before its timeout. The coordinator
integrated the saved work, and the controller also made one existing-API SDK
continuation decision. All failures remain in the same task ledger. Final
hash-bound model risk review is running; no independent final acceptance yet.

The independent source audit checked the three official releases directly,
including Microsoft's annual revenue and RPO figures that were truncated in a
retained browser event. The financial sections are byte-identical between
`phase-0` and `phase-1`; the audit pins that section hash and both report hashes.
See [`pilot-3-source-audit.json`](../../spikes/stock-supervisor-20261001/pilot-3-source-audit.json).
This validates the named source figures, not all investment inferences or the
complete final output.

Pilot 3 finished at 10:50:36.930 UTC after starting at 10:17:51.203 UTC:
1965.73 seconds (32 minutes 46 seconds). Final outcome from the controller was
`artifact-pass-awaiting-manual-audit`: eight fixed execution checks passed,
all twelve model review checks passed and the reviewed hashes matched. There
were 20 logical runs / 21 physical attempts (2 failed, 16 silent, 2 succeeded),
13 bot messages, two controller messages and one controller continuation. The
continued coordinator run `run_ab071bc987c24e9eb37554eda7bdc143` succeeded on
attempt 2 with session `b9fae8e8-9431-476b-9e96-7feda4403aaa`.

Independent audit still rejected the final deliverable:

1. With all three names ineligible at a scheduled rebalance, its own rules
   require zero target weights and cash residual. An exact-code synthetic probe
   started with cash 4000 and 20 shares of each name at prices 100, rate 0.0005,
   minimum fee 1 and adverse slippage 0.001. Selling all positions is feasible
   and leaves cash 9991 after costs. Instead, the function returned `blocked`
   and preserved every holding, reporting non-convergence with weight deviation
   zero. `_solve_post_cost_nav` checks repeated trade tuples before checking
   convergence: constant liquidation notionals repeat after the first cost
   update and are mistaken for a cycle. The eight original cases did not cover
   this eligibility combination. The report also contradicts the zero-target
   rule by claiming whole-book liquidation always needs an external decision;
   both the implementation and policy description require correction.
2. The written cash identities subtract fees from signed spending; one JSON
   identity also subtracts slippage already included in fill notional. The
   implementation's normal fills reconcile correctly, but the printed equations
   do not describe those fills. Use one explicit sign convention and derive the
   report equation from the tested implementation instead of rewriting it.

The extra probe ran candidate code only in a disposable network-disabled,
read-only container, with immutable evidence mounted read-only and no model
call. Two setup attempts failed before candidate execution (command quoting,
then evidence-owner UID permissions); these are audit infrastructure errors,
not candidate failures. The corrected probe produced the blocked result above.
No audit container remains. Compact receipt and counterexample:
[`pilot-3-summary.json`](../../spikes/stock-supervisor-20261001/pilot-3-summary.json).

Final hashes:

- Report: `9dc7baa6bfac27626c840cc65cbbaeb7996ae4d8b72cb0b4718241cdd46a5a68`.
- Strategy: `f602f321810824dec162a47a889a64794af3ced3f347f563b317d5d5a43497c3`.
- Implementation: `677b457d79ff73f12bfe21666549610a5a9ed13d1e624e10e6cd94c7638440ec`.

Recorded usage: 467,918 input; 112,924 output; 7,375,872 cache-read; 0 cache-create.
These are partial totals: the two timeout runs
`run_860a9269b5c241cfac35fd6aaf4aa35a` and
`run_52050fc3950f4e25bfa06787ac7983b7` have no aggregate usage row, so their total
usage remains unknown, not zero. Exact workspace
`ws_553cd67e20e241b6a79b767b02c65118` has no remaining containers, workspace
network or any of its three recorded volumes. Stable remains untouched.

## Next evidence-driven change

Do not repeat v3 as an accepted configuration. Repeated free-form generation of
cash/risk code and its prose has produced hidden contradictions even after
successful repair and review. The next candidate should reuse a tested,
deterministic portfolio transition core and derive its rule descriptions from
the same configuration; bots still supply the original research, source
verification, allocation choices and independent risk review. Add all eligibility
combinations to the fixed verifier and make the verifier plus numeric failure
details available to repair agents. Preserve the original three-name task,
all specialist contributions and missing-data/backtest requirements. Freeze
the candidate before one fresh pilot; no pilot 4 has been launched yet.

## Pilot 4 predeclaration: deterministic calculations and generated rule text

Evidence is pilot 3's feasible all-ineligible liquidation being rejected as a
solver cycle, plus cash equations disagreeing with actual code. The v4 workflow
therefore supplies a tested authored portfolio core and a deterministic compiler.
Model-authored research and allocation configuration remain the substantive bot
outputs. The report's execution section and JSON rules come from one renderer;
all three specialist contributions, original stocks/date/sources, recommendations,
missing data and unrun backtest remain required. This does not claim an empirical
performance improvement and does not alter the stable deployment.

Offline preflight passes: 9 core test methods (144 cost/eligibility/gap combinations,
250 fixed-seed random books), 6 compiler tests, 7 verifier regressions, 11 TypeScript
controller/oracle tests and the spike typecheck. The authored compiled fixture
passes all 11 grouped execution cases, including the retained pilot 3 liquidation
counterexample. These are synthetic calculations, not a financial backtest.

Freeze this workflow and inventory before exactly one pilot 4. Keep model, image,
original task/roles and all runtime limits constant. Acceptance still requires an
independent full-artifact/source audit after model review, followed by an unchanged
fresh repetition. A fixed pure transition does not implement a market-data feed,
point-in-time eligibility adapter, event-priority dispatcher, drawdown observer or
broker. Generated deliverables explicitly identify those external prerequisites.

## Pilot 4 result: calculations pass; workflow and research still fail

Pilot 4 ran 11:14:31.667–11:26:19.461 UTC (707.79 seconds). It generated the
original report and strategy, and all eleven fixed execution groups passed,
including full liquidation. The core hash matches the preflight-tested authored
file. This isolates progress to deterministic calculations, not overall quality.

The final risk review attempted `Write /tmp/risk_final_sim.py`. The existing
sidecar classifies file writes outside `/work` as L2; it correctly requested
approval. The frozen controller stopped on that pending approval without
granting it. No final hash-bound risk verdict was produced. The first specialist
risk attempt also timed out at 300 seconds; the coordinator successfully
reassigned a narrower review before the later final-review interruption.

Independent audit of the final report (unchanged from phase 0) found retained
research failures: the claimed-corrected allocation rationale was still embedded
verbatim with unverified MSFT/unresolved NVDA claims; Microsoft's Q4/guidance EPS
benefit was mixed with annual EPS growth; future NVIDIA margin guidance was used
as a statement about current margin expansion; a 50% reduction was incorrectly
called the largest reduction preserving holdings; execution-cost, correlation and
future earnings-calendar assertions lacked evidence; quarter-end age was confused
with release age. Details and artifact hashes are in
[`pilot-4-pre-review-audit.json`](../../spikes/stock-supervisor-20261001/pilot-4-pre-review-audit.json)
and [`pilot-4-summary.json`](../../spikes/stock-supervisor-20261001/pilot-4-summary.json).

There were 15 logical/physical attempts. Final DB states: 7 silent, 1 succeeded,
1 stopped, 1 waiting approval and 5 failed. Of the five failures, one is the real
review timeout; three exit-137 failures and one stopped-container 409 arose during
teardown after the approval stop. They are retained but are not four additional
model-quality failures. Recorded partial usage: 234,173 input, 54,006 output,
1,920,512 cache-read, 0 cache-create. Five attempts have no aggregate usage rows;
missing coverage is unknown, not zero. The final artifact snapshot predates those
teardown transitions; the final DB closeout records them separately.

Exact workspace `ws_a9f8ec7630644b51bbb54c762282f92e`, its containers, network
`deskmates-net-ws_a9f8ec7630644b51bbb54c762282f92e` and all three recorded volumes are
absent. Stable was untouched. V4 runtime is preserved under `policies/v4/` and its
hash-verified transfer archive. This pilot is not an accepted repetition.

## Pilot 5 predeclaration

The next single change is the workflow instruction policy: use `/work` for scratch
scripts under the existing risk classifier, save intermediate findings early,
update both compiled inputs when evidence changes, and review the six concrete
pilot-4 inference failures before finalizing. Keep the numerical core, compiler,
fixed verifier, original task, roles, source pack, model/image and budgets exactly
unchanged. This targets the observed approval interruption and false claim of a
corrected report; it is not an increase in model effort or a hidden retry of pilot 4.

Preflight: 12 controller/oracle/policy unit tests and spike typecheck pass. The new
policy-path regression confirms `/tmp` writes request L2 approval while `/work`
writes are L1, and traversal remains L2. The existing 22 Python tests cover unchanged
bytes. Reserve one pilot 5, then one unchanged prospective pilot 6 only if its
independent audit passes. This expands a local launcher label range, not a user
cost budget; every attempt and unknown token coverage remains in the campaign.

## Pilot 5 result and pilot 6 predeclaration

Pilot 5 ran from 11:34:59.628 to 11:54:39.853 UTC (1180.23 seconds). All 24
physical/logical attempts terminated normally: 19 silent and 5 succeeded. The
controller exhausted six repair messages without acceptance. All eleven fixed
execution groups passed, but risk review retained issuer re-entry blocker B1:
after verification exit, a later all-eligible rebalance could buy that issuer
again. The core trusted the external eligibility input; the canonical prose
claimed stronger protection than that unimplemented adapter supplied. Bots could
only change inputs, so repeated repairs could not fix the immutable component.

Independent audit also rejected Microsoft OpenAI reconciliation-sign confusion,
unsupported cross-issuer breadth rankings, omission of NVIDIA's disclosed Edge
Computing segment, and an overstated test-coverage claim. Actual tool receipts
contain a 4000-state mixed-action probe and separate 6000-state rebalance probes;
they do not establish the report's combined all-actions, all-invariants claim.
See `pilot-5-source-audit.json` and `pilot-5-summary.json` in the spike directory.
Usage is fully covered: 476443 input, 126466 output, 8173056 cache-read, zero
cache-create tokens. Exact workspace ws_9f768982c1ad404caceb5f882e572180, its
network, containers and three volumes are absent. Stable remains untouched.

Pilot 6 is explicitly re-declared as a NEW v6 candidate, not the previously
conditional unchanged repetition of v5. Preserve v5 under policies/v5. V6 adds
persistent invalidatedIssuers state to the authored transition, including zero
holdings and a blocked liquidation. Rebalancing cannot reopen those issuers;
evidence-based removal from this state remains an external workflow, explicitly
unimplemented. The compiler renders that same boundary into both deliverables.
The verifier adds four grouped cases and corrects the observed half-cash floating
point boundary and inappropriate application of monthly caps to passive drift.

The other observed failure is addressed by an operator-side evidence review
within the SAME task's repair loop. It binds every saved artifact, requires seven
evidenced checks, and may request concrete repairs or stop on an immutable
defect. A missing/stale independent review cannot pass; independent approval
does not override the model review or machine checks. This is a supervised
workflow candidate, not autonomous financial verification. No extra task POST,
model change, larger budget or security-policy relaxation is introduced.

Preflight passes: 12 core, 7 compiler, 8 verifier and 16 TypeScript unit tests,
plus spike typecheck. Freeze and inventory before one fresh pilot 6. Keep original
task, four roles, source pack, GLM-5.3, image and all limits unchanged. Only after
full independent acceptance may pilot 7 repeat those identical bytes. All prior
failures remain retained; this iteration does not establish general reliability
or authorize production-default adoption.

## Pilot 6 result: original bounded task accepted with independent repairs

The frozen v6 instance ran 12:13:19.212–12:42:20.511 UTC (1741.30 seconds).
Final controller status is `verified-artifacts`. All 24 logical/physical runs
terminated normally (18 silent, 6 succeeded); five controller messages and no
continuations were used. All fifteen fixed execution groups pass. The report,
strategy, current fundamentals deliverable, all role contributions and final
model review were checked against exact bytes and actual tool evidence.

Independent phase 1 rejected the model PASS for source-adjustment direction,
period comparisons, hypothetical-versus-observed holdings, state-boundary
misdescription, an omitted original researcher filename and stale review claims.
The same task corrected its inputs and regenerated both outputs. Phase 3 found
one retained contradictory risk-summary paragraph; the next repair replaced it.
Phase 5 passed all seven independent checks. The specific receipts are retained
in `spikes/stock-supervisor-20261001/pilot-6-independent-audits.json`; the earlier
failures were not discarded or relabeled. This is evidence for a SUPERVISED
completion workflow, not model-only autonomous source accuracy.

Final report SHA256: e1bb4609316314cbad5fdda0295f6fcb45ac6da89ed99f31e99782fc4904363b.
Strategy: a093c58808bea64efa9059d706b236e67f8099cae237a6f5fe46cce35fae2a8f.
Core: 32a1d4a68df0064d1d08d9081dc55da91d91dc7973709051fd514e8283a12930.
The task remains research plus a fractional execution simulation; live market
data, historical backtest, evidence adapter, dispatcher, drawdown observer,
clearance workflow and broker are explicitly absent. No trades occurred.

Recorded Gateway usage is fully covered: 447963 input, 124874 output, 7975936
cache-read and zero cache-create tokens. Independent operator model usage is
outside these Gateway totals. Exact workspace ws_a04146c7392b4639bf4d1729f8ae63a2,
its network, containers and three volumes are absent. A read-only cleanup
receipt initially rejected Docker's lowercase `no such volume` text; correcting
that receipt parser confirmed absence without deleting additional resources.
Stable remains untouched. See `pilot-6-summary.json` for the full closeout.

Proceed with the predeclared pilot 7 as ONE unchanged prospective repetition:
same v6 archive d25f0b77e923798568cdff08f1c693e77a5b3b91ae8b842d10052e23b2caef30,
original task/roles/source pack, model/image and limits. The same independent
evidence gate and bounded repair workflow apply, without pre-seeding pilot 6's
answers or outputs. Its result remains unknown until tested; one accepted
instance does not establish general reliability or production readiness.


## Pilot 7: unchanged prospective repetition accepted

Pilot 7 used the same frozen v6 archive, original task/source pack/roles, model,
image, parameter values and budgets as pilot 6, with no prior answers seeded.
It ran 12:46:42.496–13:25:54.533 UTC (2352.04 seconds, about 39 minutes).
The terminal controller status is `verified-artifacts`; launcher exit is zero.
All fifteen fixed execution groups and twelve current bot risk-review checks
pass; the final independent receipt passes all seven evidence checks and binds
all thirteen non-null artifacts. The collected final hashes match that receipt.

There were 25 logical runs and 26 physical attempts: 18 silent, six succeeded
and one stopped. The first researcher attempt saved its source work, reached
its typed turn limit and had continuation explicitly denied by the coordinator;
that stopped attempt remains recorded. A later lead repair reached 18 turns,
was continued once in the SAME logical run, and completed successfully. This
exercised the SDK correction in the actual stock scenario without raising any
limit. The controller used five messages and one continuation decision.

Independent phase 1 rejected the model's PASS on seven blocking issues: pending
MSFT publication date versus claimed eligibility; unsupported diversification
ranking; overly broad NVIDIA non-GAAP comparability claims; a false half-cash
verifier-failure assertion; a hand-repaired source cell and misleading extraction
absence; missing current fundamentals filename; and inconsistent draft rules.
The bots reread sources and repaired the current inputs. Phase 3 then caught
asynchronously stale date/re-read fields still present in strategy-draft.json.
The second targeted repair synchronized those fields and clarified residual
rounding; phase 5 passed. Both rejected reviews and the final acceptance are
retained in `pilot-7-independent-audits.json`. Model review alone missed material
issues in both accepted trials; independent review is part of the method.

Minor retained limitations: fundamentals.md uses rounded residual arithmetic
wording, while explicitly warning against treating it as an exact segment;
final report/draft clarify the precision. A browser output wrapper retained
Microsoft's origin after selection of the NVIDIA tab. Actual tab-list results
and primary-page verification established provenance; wrapper metadata alone
must not establish source identity. See `pilot-7-provenance-note.json`. No frozen
runtime changes were made to hide either observation.

Recorded Gateway usage is fully covered: 612801 input, 207081 output, 14882816
cache-read and zero cache-create tokens, including the stopped and continued
attempts. Independent operator model usage is outside these totals. Exact
workspace ws_c43df20ccf5543c2a12f76f01f41344e, its containers, network and three
volumes are absent. The read-only `closeout-stock.py` verified the ledger and
exact-resource absence; `pilot-7-summary.json` records the result.

Final report SHA256: c9ddad017ddbd63d0e8ea611c1e72a4cfadeb114b523aa61e9b898715f56e252.
Strategy SHA256: 03f57c747d872f3669330687a4502cbfa19e42f342bb30e10305e654200c3df6.
Core remains 32a1d4a68df0064d1d08d9081dc55da91d91dc7973709051fd514e8283a12930.

## Supported conclusion and remaining scope

Two fresh v6 instances completed the original AAPL/MSFT/NVDA research and
executable-rule specification in about 29 and 39 minutes respectively, both
with two independent repair cycles. Their different judgmental allocations
are not optimization results. The tested workflow combines bounded continuation,
saved progress, deterministic rule compilation/checks and source-grounded
operator feedback; simply increasing effort or limits did not solve the earlier
examples. Preflight coverage remains 12 core + 7 compiler + 8 verifier Python
checks, 16 TypeScript checks and spike typecheck; the separately verified SDK
fix passed its package checks and real original/fixed regression.

This is sufficient to deliver the requested working method for this bounded
scenario. It does not prove a globally best configuration or guaranteed success,
replace paired strategy evaluation, or authorize production-default adoption.
Price/valuation/history data, historical backtesting, eligibility construction,
event dispatch, mark-to-market observation, clearance and broker execution remain
explicitly absent. All three final recommendations are watch, with missing-data
limits stated; no trades or investment performance are claimed. Stable remains
untouched. No additional model trial is needed for this scoped completion.

## Pre-commit verification

The final working tree passed root typecheck and Biome lint, both spike
TypeScript configurations, 89 sidecar run-once regression tests, 16 controller
tests and 27 Python tests. Root Vitest excludes spikes; the controller tests
were run separately with `node --import tsx --test`. Runtime files still match
the pilot-6/7 frozen inventory; only the result documentation changed afterward.
The 99 spike files selected for version control contain compact evidence and
frozen policies, not ignored working transcripts or credentials. No new full
T2/T3 release gate was run for this commit; stable deployment remains unchanged.
