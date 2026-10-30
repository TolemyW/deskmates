# Goal-first real-model lifecycle results

Date: 2026-10-21
Scope: owner-requested functional validation of the ADR-0052 working branch, followed by fixes.
Verdict: the final synthetic core journey passed its state/file/version oracles. This is not
release acceptance or evidence of statistically better strategy. The owner-approved evidence
rule also passed one real-model job containing supported, unsupported and contradictory cases.

## What actually ran

Four isolated workspaces exercised successive candidates with the configured primary and
auxiliary models, real Gateway, SQLite, Docker workspace, SDK and browser UI. The running
stable service and its data were not test fixtures and were not upgraded. Source inventories
and hashes excluded credentials, history and dependencies; the lab retained every attempt.

The same team request asked the assistant to create or reuse analyst and editor teammates,
start a weekly-report group, calculate synthetic orders, hand the calculation to the reviewer
and summarize after review. The formal task then required a real report, checkpoint and JSON
output. Human feedback changed refunds from 20 to 30 and target from 200 to 220; a repeated
identical feedback submission tested idempotence. A separate natural-language correction
tested shared memory, followed by a fresh conversation whose question contained no target.
Formal task creation and revision submission were test-driver API actions through the product's
normal routes; final acceptance used the signed-in browser. The models wrote the real files,
checkpoints and deliveries. This does not verify an assistant autonomously creating a formal
task from the initial team brief.

Each physical run was capped at 25 turns and 900 seconds; model jobs were tool-free with their
one-turn bound. The final candidate had 18 runs: eight message runs, one welcome and nine
auxiliary jobs. The first three workspaces together had 60 logical runs and 60 physical attempts:
53 succeeded and seven stayed silent. The evidence-policy fixture added one successful real-model
job in a fourth workspace: 61 logical runs and physical attempts in total, 54 succeeded and
seven silent. These include welcome, activity summaries, maintenance
and earlier unsuccessful workflows; they are not 60 retries of the business task.

Private lab material: **Goal-first real-model lifecycle validation, 2026-10-21**. It contains
frozen source and image inventories, every run/config/event/usage receipt, the original and
corrected oracles, verified report bytes, UI captures and the retained ledgers. Deployment
identifiers and transcripts remain there. The tested runtime descends from commit `25d6933`;
the inventories identify each subsequent working candidate exactly. The evidence-policy runtime
archive SHA-256 is `d91a7938e008368063e7cfdc42a9ca13d67e8b5cda4fb42713a8ba135ca82317`
(114 inventoried files); its workspace image is
`sha256:2573d3a3a124d55d93ebd18348ef9f6c4c70da1ecabf09e6ce0a0b9d4b89c680`.

## Final observed behavior

| Step | Evidence and outcome |
| --- | --- |
| Creation | Exactly assistant, analyst and editor; ordinary create/SOUL/welcome mechanisms, no model or permission expansion. |
| Initial routing | `startWith: ["analyst"]` woke only analyst even though the assignment text also mentioned editor and assistant. |
| Handoff | Group bot messages were kickoff, analyst calculation, editor review, then assistant summary, in that order. No source-chat undelivered-mention notices. |
| First delivery | Real report plus checkpoint and schema output: net orders 180, target 200, gap -20, completion 90%. Delivery awaited a human. |
| Revision | One feedback submission advanced scope, started work and delivered 170, 220, -50 and 77.27%. Repeating the same key returned the same submission. |
| Evidence retention | Both deliveries and their distinct files remained. Downloaded report bytes matched each publication's recorded SHA-256. |
| Human acceptance | A normal signed-in browser reviewed the structured output and rendered report, then accepted; the task recorded the authenticated user. |
| Fact correction | The trusted project-target statement changed to 220; the 200 statement became superseded history. One current value remained for that fact key. |
| Fresh recall | A fresh conversation pinned the new entry/version and excluded the superseded entry. The model answered 220 without the question supplying either value. |
| Episode closure | The existing explicit close-task action distilled two task notes into one episode; a repeated close created no second episode. This was not automatic acceptance integration. |

All 18 core state/file/version assertions passed. The first oracle incorrectly counted a
separate revision-history note as a second project target by substring matching. Both its
failure and correction are retained: the corrected check follows the original fact key and
supersession receipt, and reports that extra history note as a quality finding rather than
hiding it. A correct recall answer alone was never sufficient to pass memory storage.

## Fixes prompted by the live runs

- Explicit kickoff recipients replaced reliance on prose alone. Earlier runs woke the reviewer
  before its input existed, and one assistant summarized before the actual reviewer replied.
- A successful group's source creation report no longer turns undeliverable teammate-name
  references into failed private handoffs. Deliverable mentions retain their routing.
- New assistant and tool guidance describes ordered handoffs and avoids acknowledgement
  mentions. The welcome describes approval modes accurately and does not promise setup questions.
- Current-fact and scope guidance keeps a shared project target in workspace memory and
  describes old values in the reply. A successful final correction superseded the old entry;
  this does not establish robust semantic matching across arbitrary paraphrases.
- Inert chat notices expose gated, excluded and untrusted memory outcomes. Earlier assistants
  said a correction was remembered when its actual write awaited confirmation or was task-only.
- Owner-approved ADR-0053 replaces confirmation by absence of contradiction with a fresh,
  exact quote from the job's frozen shared-message evidence. The Gateway checks source id,
  SHA-256, quote and timestamp; unsupported `still_true` becomes `unclear` without renewal.
  Legacy jobs without frozen evidence cannot renew notes. System notices and task metadata
  stay context only, and private chats stay excluded.
- Reopening copy now distinguishes clearing current status from deleting delivery history,
  in all five UI locales. The final build preserves the previous evidence.

## Findings retained as open

**The original revalidation produced an unsupported confirmation.** An explicitly seeded,
two-day-old synthetic quota note was automatically rechecked by a real model. It renewed the
note because unrelated recent activity gave no sign of change, as the original prompt allowed.
That counterexample and its ledger remain intact. The owner then accepted ADR-0053 and the
branch implemented the evidence requirement; the original verdict was not rewritten.

The new candidate ran one real, tool-free cheap-model job after the actual periodic sweep,
with three explicit seeded-age fixtures. All 17 source/version/privacy assertions passed:

| Case | Real model verdict | Persisted outcome |
| --- | --- | --- |
| Old quota 12, no fresh public support | `unclear` | Version 1, no confirmation time, flag stays open. A private statement supporting quota 12 was excluded from the input. |
| Old weekly target 220, new shared statement confirming 220 | `still_true` | Version 2, exactly one `confirm` attributed to that run. The exact quote, source id, SHA-256 and source time matched its frozen input. |
| Old ledger host, new shared statement saying it moved | `possibly_stale` | Version 1, no renewal, existing human-review queue. |

The job recorded policy version 2, completed in one physical attempt and made no duplicate
submission. Bodies, trust and scopes were unchanged. These are synthetic age/source fixtures,
not natural 24-hour observations. Offline tests separately exercise forged/foreign citations,
stale/future dates, mutated transcripts, legacy jobs and service reconstruction. Exact citation
validation proves source presence and time, not semantic entailment: an irrelevant but exact
quote remains a model-quality risk. A paired accuracy comparison is still pending.

**Acceptance still needs a separate memory-close action.** ADR-0021 decision 2 explicitly
separates acceptance of a task record from closing its thread's memory notes.
Human acceptance left two task notes open; the test deliberately invoked the existing close
API afterwards. Automatic work-end episodes and later consolidation are not passed by this
journey. One episode also does not meet the normal three-episode consolidation trigger; that
threshold and its idle/cooldown policy were preserved.

**Memory presentation is not semantic normalization.** The analyst also saved a revision-history
statement in workspace scope, containing both old and new numbers. It did not replace the
current project target, but history placement remains unreliable. Arbitrary rewordings can
have different deterministic fact keys. No trust gate or fact-key policy was weakened to make
the journey pass.

**Review context can still be easier.** The task keeps its original goal description while
feedback is durable in its execution conversation. The latest result explains the revision,
but the human's latest feedback deserves a clearer place beside it. Tasks still have no live
subscription. These are retained interface findings, not claimed fixes.

The test covers one small synthetic business journey, not external-system competence,
mobile/second-role acceptance, migration of existing saved SOULs or economic value. Independent
review of three numbers does not prove that multi-bot coordination earns its overhead on real
work. Paired quality, reliability and cost evaluation remains pending.

## Decision cost and product value

The observed improvement is fewer disconnected steps, not proven business return. The assistant
selected and created the two roles, and explicit kickoff routing removed the need for a person
to manage which teammate starts. Revision feedback now dispatches work through the same keyed
action that reopens and advances the task, with prior evidence retained. Unsupported freshness
checks stay uncertain without asking a person to approve every old note; evidence of change
uses the existing human-review queue.

Two important joins remain manual or unverified: the team brief was not autonomously converted
into the formal task in this test, and task acceptance does not close task memory notes. The
original goal also remains visible beside a revised delivery while the latest human feedback
is in the execution conversation. These are remaining decision/context costs in issue #69.
The USD total below covers all exploratory and auxiliary work, not the marginal price or ROI
of a normal business task. More bots reviewing easy arithmetic can add overhead; this journey
establishes mechanics, not that delegation is economically worthwhile.

## Accounting

Every run had usage; no token field was unknown. Costs below are Gateway price-table estimates,
not invoices. Input and cache fields are reported separately as the ledger records them.

| Model role | Input | Output | Cache read | Cache create | Estimated USD |
| --- | ---: | ---: | ---: | ---: | ---: |
| Primary | 613,346 | 23,063 | 622,592 | 0 | 0.487230 |
| Auxiliary | 1,310 | 8,236 | 6,080 | 18,496 | 0.015864 |
| Total | 614,656 | 31,299 | 628,672 | 18,496 | 0.503094 |

The preview was drained after all 61 runs became terminal, so it starts no further model work.
Completed earlier and evidence-only workspaces were stopped after exact ownership checks; the final task preview
and evidence remain reviewable. No cleanup selected a shared name prefix or pruned images.

## Local verification

Typecheck, lint, documentation checks and the production Web build passed. Focused route,
relay, sidecar, context, memory-notice, citation and task-UI regressions passed. The intended
memory-guidance changes are strategy changes, not claims of unchanged model behavior or
statistical improvement; the context prompt golden was updated explicitly.

The latest full suite passed **878 files and 8,272 tests** in 609.11 seconds with
`npm test -- --maxWorkers=4 --testTimeout=15000`. The normal five-second invocation had 8,268
passes and four timeouts in the unchanged `scripts/stable/stable.test.mjs`; a standalone run
with that same default still had three timeouts and 37 passes. All 40 tests in that file passed
in the final full run at the 15-second command-line deadline. No repository timeout setting or
assertion was changed. These original failures remain in the lab, and the final pass must not
be described as a clean default-deadline run. The previous candidate's 877-file/8,266-test clean
run and separate 108-test recheck are also retained as historical evidence.

Earlier local failures, including a restricted-loopback test launch, resource-contended fixture
timeouts and ADR table formatting, remain in the lab logs. The loopback tests ran with the
required local-listener permission. Build output retains the existing large-chunk warning.
The tracked-tree public scan and its three tests passed. A final fixture-only portability edit
generalized the isolated-directory guard while continuing to reject stable paths; Node syntax
and the public-scan tests were rechecked afterwards. It changed no runtime or model input.
No T2/T3 release campaign, merge, tag or stable deployment is implied.
