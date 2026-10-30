# Stable v0.7.10 live lifecycle and presentation check

Date: 2026-10-22
Deployed revision: `6574c56aa71e1fad62f6bbb811937c2741d1c085`
Result: **issues found; not a blanket acceptance pass**.

Private evidence: **Stable live lifecycle and presentation acceptance,
2026-10-22**. The lab retains reserved message IDs, prompts, every run and event,
frozen configurations, usage coverage, three downloaded delivery files and their
publication hashes, browser screenshots, memory versions and recovery receipts.
No credentials, private deployment identifiers or screenshots are included here.

## Scope and method

The owner requested another real-model lifecycle check against the newly released
stable instance. A new isolated workspace held synthetic order data only. Normal
operator APIs created the fixture and formal task; real bots created the two
specialist bots and group, performed calculations and handoffs, wrote files,
checkpointed and delivered. The signed-in UI submitted both revision requests
and accepted the final delivery. The driver did not write to the database or
patch the deployment. Unrelated workspaces and services were not touched.

Each model run was capped at 20 turns, no continuation, with bounded thread/relay
limits and a USD 2 cumulative workspace budget. Each human request was reserved
before its single POST. Infrastructure failures, automatic bot recovery, silent
runs and partial token coverage are retained rather than rerun away.

This is a functional/product check, not a paired strategy comparison, a milestone
acceptance suite, a natural-day memory recheck or a reliability estimate.

## Observed journey

| Step | Observation | Result / limit |
|---|---|---|
| Bot creation | The assistant used the real creation tools to create analyst/editor and a three-bot group; only analyst was started initially | Passed; no manually pre-created specialist bots |
| Group handoff | Analyst computed, editor independently checked, assistant summarized; one upstream editor failure produced a durable outcome and analyst initiated one recovery handoff | Completed, with unnecessary wakes and noisy failure presentation below |
| Initial task delivery | A=145, B=95, refunds=18, target=250 produced net=222, gap=-28, completion=88.80% | Correct structured output; the operator created the formal task |
| First revision | UI feedback changed refunds to26 and target to280; delivered net=214, gap=-66, completion=76.43% | Numbers correct, prose incorrectly called 8 orders about 8 percentage points |
| Second revision | Concrete UI feedback removed the unsupported attribution; v3 retained the correct output and mathematical relationships | Accepted through UI after inspecting the actual file |
| Publication | Three separate delivery files retained, downloaded and SHA-256 checked against all three publications | All matched; earlier versions remained available |
| Long chat | Historical and latest long bot replies used excerpts with an explicit full-reply control; latest badge remained unique | Passed observed states; 1,290-character reply inspected |
| Expand while reading | With an unsent draft, expanding editor kept scrollTop=1775 and preserved the draft; a live reply/SSE update kept both and the chosen expansion | Passed; the probe draft was cleared afterward |
| Jump to latest | Clicked the actual control, measured final bottom gap=-0.5px | Passed within rounding tolerance |
| Initial memory save | Shared-group save became an untrusted workspace note; the bot nevertheless said it was saved and available in a new chat | Trust handling worked; user-facing claim misleading |
| Fresh-session recall | A genuinely new group/session recalled250 from diary with an empty pinned-memory version set; after trusted private correction, a second fresh session recalled280 with the expected pinned entry and no tool calls | Diary and pinned-memory provenance must be distinguished; not proof of a trust bypass |
| Trusted memory round trip | 280 ->300 superseded the trusted280 note; 300 ->280 was wrongly deduplicated and left300 current | Failed; deterministic multi-number collision |
| Recovery | Normal operator undo restored the original trusted280 note and closed300 | Manual recovery, not an automatic-update pass |
| Task memory closure | Accepting v3 left three live task notes; an explicit close-task action distilled one episode, and repeated closure created none | Closure works; acceptance and memory closure remain separate actions |

A first fixture name exceeded the product's 32-unit limit and was rejected before
any model run. A first "new chat" recall attempt reused the canonical single-bot
inbox; it is retained but excluded from fresh-session evidence. The later recall
checks used newly created two-bot groups, addressed only the assistant and
verified different SDK sessions and frozen context version sets.

## Findings and changes

1. **P1: a memory change can be lost as an equivalent copy.** The model correctly
   submitted "current280, replacing300". Both it and "current300, replacing280"
   produce `is|280,300` with the same fact key. The Gateway recorded
   `deduplicated`, advanced the old300 note's effective time and kept its body.
   This is a storage-decision failure, not model failure. ADR-0054 proposes a
   conservative change for multi-number notes; no unapproved memory strategy
   was applied to stable. Old/untrusted250 wording also has a different key and
   remains live: the heuristic does not guarantee all paraphrases supersede.
2. **P2: selected task detail becomes stale after delivery.** The list could say
   awaiting review while the detail still offered Start work. Refresh list did
   not refresh the selected row. The fix follows recorded task messages and
   terminal runs and refreshes both list/detail manually, without posting work.
   Reconnect catches missed events; unsent goal edits and revision feedback
   keep their old base version and show a conflict instead of being discarded.
3. **P2: a newly listed workspace cannot be selected before reload.** The paged
   directory knew the new workspace but the shell's initial name map did not.
   The fix resolves the selected authorized row before committing selection,
   handles failed reads and ignores obsolete responses after a later choice.
4. **P2: unsupported Unicode paths become fake ASCII-prefix downloads.** A path
   ending `editor_` was linked while the rest of the Chinese filename remained
   plain text. Both chat parsing and the file collection now reject that false
   prefix. Full Unicode download/delivery support remains outside this fix:
   ADR-0014 currently specifies the ASCII path protocol. The model's Chinese
   delivery filename was refused and an ASCII copy was successfully delivered.
5. **P2: future mentions are real immediate routing.** "After review, @assistant"
   in a message to editor also woke assistant, producing two extra silent runs
   in this journey. The displayed To metadata accurately reports actual
   recipients; plain-language intent is still too easy to misread. A structured
   handoff should separate recipient, request, result and next step.
6. **P2: one failure is shown twice with implementation noise.** A run outcome
   card and durable delegation message both showed the upstream SDK error and
   stack. Keep the durable failure, retry/source attribution and diagnostics,
   but show one concise product-facing outcome with details on demand.
7. **P2: task acceptance and memory state are poorly connected.** Accepting work
   did not distill its task notes. The original task description also kept the
   old250/18 inputs while accepted output showed280/26. Revised scope and the
   accepted version should be visible together. Task qualifications and the
   delivery summary remain long blocks and can bury the headline metrics.
8. **Provenance language is overconfident.** Fresh sessions claimed that a user
   statement occurred "in this thread", although it came from supplied diary
   or pinned memory. Recall correctness alone is insufficient evidence that
   the saving and trust lifecycle worked.

The code fixes in2–4 are in a review branch, not deployed patches. Routing,
trust, diary supply, ASCII file policy and automatic task acceptance were not
changed. Cross-private-chat delivery was not exercised: approval review
rejected the needed allowlist change; a temporary narrowly scoped change and
restoration were presented to the owner separately. Group handoffs above were
exercised in full.

## Run and token accounting

38 logical runs /38 physical attempts:34 succeeded,2 silent,2 failed, no active
runs at capture. These include inexpensive internal summary/model jobs, so they
are not38 independent user tasks. One failure was the unavailable configured
fallback model; another was a55-second inexpensive-model timeout. A succeeded
editor run also has partial usage coverage.

| Configured model | Input | Output | Cache read | Cache create | Recorded configured-price USD |
|---|---:|---:|---:|---:|---:|
| glm53-internal |304472|24560|1115136|0|0.359379|
| deepseek-v4.1-flash-internal |982|5386|6592|11712|0.010311|
| Total recorded |305454|29946|1121728|11712|0.369690|

35 runs have complete usage coverage and3 partial. The unavailable fallback
reported no covered tokens; that is unknown coverage, not evidence of free
inference. USD0.369690 is the recorded configured-price sum, not a complete
upstream invoice. Internal SDK fallback requests are preserved in each run's
requested/served-model receipts.

## Validation

Before integration with the subsequently merged main: full typecheck, lint,
docs consistency and web production build passed. Full T0/T1 passed882 files /
8293 tests with localhost listening permitted. The first sandboxed full run was
interrupted after localhost listeners were denied; it is not counted as a code
failure or as a pass. The targeted task, path and workspace regressions passed.

After integrating main at `f086684`, the final full typecheck, lint, docs
consistency and web production build passed. Full T0/T1 passed882 files /
8296 tests (166.43 seconds). The source public-identifier scan also passed.
The production build retains its existing large-chunk warning. No T2/T3 release
gate, paired memory experiment, release tag or deployment is claimed for this
follow-up branch. The review is draft PR#75; memory policy remains proposed.
