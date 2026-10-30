# ADR-0016: A run that runs out of turns is parked, and whoever delegated it decides

Date: 2026-09-29
Status: Accepted for implementation (product owner authorized the 2026-09-30 interaction optimization scope). Deterministic unit checks are recorded below; SDK/container and real-model acceptance remain pending.
Source: the shared-work-state board trial on the stable instance, 2026-09-29 (`spikes/shared-work-state/`, `docs/design/m3-shared-work-state-spike-2026-09-29.md`). Builds on ADR-0002 amendments 1 and 2 (park, resume, any member decides) and ADR-0005 (threads, wake, caps).

## Context

In the board trial, team_chief delegated five research tasks. Three of the five expert runs (databricks_fan, poor_developer, opensource_fan) stopped after about 15 minutes with `Reached maximum number of turns (50)` and ended `failed`. They had written nothing: the rules asked for results at the end. Nobody was told. The run failure is not posted to the thread, the chief is not woken, and the chief, which waits until every delegated task is done, waited indefinitely. One of the three was later resumed only by accident, because a chief message without a mention woke it.

The work was not all lost. `RunLifecycle.ended` stores the run's SDK session for the `(bot, thread)` before it looks at the outcome, so a later wake of the same bot in the same thread resumes with everything the failed run had seen. What is missing is a decision point: nobody sees that the run stopped, why, or what it had done, and nobody can say "go on".

`DESKMATES_MAX_TURNS` is one value for the whole Gateway (default 50). Raising it would let these runs finish, but it applies to every bot and every run, hides why the turns were spent (in the trial: repeated `Browser control changed` errors and a 50-call shell loop), and spends more before anyone looks.

SDK 0.3.278 ends such a run with result subtype `error_max_turns`, and a `PostToolUse` hook can return `additionalContext` to the model.

## Definitions

- **Delegator**: the author of the thread message whose delivery started the run (`runs.trigger_ref`). A bot if a bot member posted it, the humans of the thread otherwise.
- **Continuation**: resuming the same run row, as a new attempt, with `resume: sessionId` and a fresh turn budget.
- **Handoff**: what the bot has finished, what is left and where its partial results are, written by the bot before its turns run out.

## Decision

1. **The run is warned before its turns run out.** The sidecar counts assistant turns. When 5 remain, its `PostToolUse` hook adds to the model's context: the number of turns left, and the instruction to save partial results into the workspace and write a handoff (a file under `/work`, and on the board where one is in use). The warning is harness text, not page content.

2. **Running out of turns parks the run instead of failing it.** `error_max_turns` ends the process with a new outcome, `turns_exhausted`. The run goes to `waiting_continuation`, keeps its session and holds its thread the way a parked approval does (ADR-0002 amendment 2, "A parked run holds its thread"). Other failures (`error_max_budget_usd`, the wall-clock deadline, crashes) are unchanged and still end `failed`.

   Amended by ADR-0029 decision 4 (accepted 2026-10-17): a platform interruption (a drain, a Gateway restart, an operator force-stop during an upgrade) is not a crash of the run. It parks as `waiting_platform` and continues automatically, without asking the delegator, within ADR-0029 decision 6's caps. Sidecar crashes, the deadline and the budget cap still end `failed`.

3. **The delegator is asked, through the approval path.** The Gateway posts a `system` message in the run's thread: which bot, the delegating message, turns and tokens used, and the path of the handoff. It carries no page content; the handoff is referenced by path, and a bot reading it treats it as another bot's text (ADR-0005 item 9). The request is an approval of kind `continuation`. Posting it wakes the delegator only, not every member: a bot delegator on the interactive lane, human delegators through the UI's approval inbox. Any member may still decide, by the rule of ADR-0002 amendment 2.

4. **Three answers.** `continue` resumes the run as a new attempt with a fresh `maxTurns`; `stop` ends the run as `stopped` with its handoff as the run summary's `done`, so the delegator can reassign the work or report the gap; no answer within 24 hours is `stop`. A decision by a bot uses `approval_decide`.

5. **Two continuations per run.** A run may be continued at most twice. Its third exhaustion ends it `failed` and posts a final notice to the delegator. The count and the limit are on the run row and in `runs.config_json`.

6. **Caps and accounting stay honest.** The continuation request and its echo are `system` messages: they do not count toward `turn_budget` or `relay_count`. Each attempt's tokens are recorded against that attempt, as for approval resumes.

The implementation stores a continuation as an approval with a distinct `kind` inferred from its reserved `__run_continuation__` action. The existing approval decisions `allow_once` and `deny` mean Continue and Stop for this kind; `allow_always` is rejected and cannot create a rule. The Web UI shows Continue and Stop. This reuses the established approval table without broadening its stored rule vocabulary. Cron/webhook runs have no thread author; their request appears in the human approval inbox. A scheduler sweep settles expired requests within one minute of the 24-hour deadline.

For runs without a thread, the usage store subtracts prior attempts' cumulative totals for the same logical run. For thread runs, existing SDK-session usage deltas remain authoritative. Both paths retain one row per attempt and model. The sidecar saves a bounded host-authored handoff under `/work/handoffs/` when the SDK reports `error_max_turns`; it may contain only the last assistant text if the bot did not write its own richer handoff.

## Alternatives

- Raise `DESKMATES_MAX_TURNS`: rejected as the answer. It is global, it spends more before anyone looks, and it does not tell the delegator anything. It stays a knob.
- A per-bot or per-task turn budget: useful later, not this decision; it still needs something to happen when the budget runs out.
- Continue automatically: rejected. Nobody judges whether the run is making progress, and spending is unbounded.
- Tell the delegator with an ordinary thread message and let it mention the bot again: rejected. A mention starts a new run, which loses the run identity, per-attempt accounting and the continuation cap; it is also what happened by accident in the trial.
- Wake every member, as an approval request does today: rejected. Only the delegator knows whether the task is still worth doing, and waking all members costs silent runs.

## Verification

| Item | Concrete meaning | Test | Metric |
|---|---|---|---|
| 1 | With `maxTurns` 12 and a fake SDK that keeps calling tools, the model context gets exactly one warning after turn 7, stating 5 turns left | T0 `packages/sidecar/src/turn-warning.test.ts`; T2 `acceptance/m4-turn-exhaustion.container.test.ts` ("item 1"): **pass** 2026-10-09, 4.0 s / 4.1 s (two runs), image `sha256:c4258dab7de4`, source `cc60cd4`; the `PostToolUse` `additionalContext` is in the SDK 0.3.278 request of turn 8 and nowhere earlier, exactly once. Real model: not run | runs with a handoff file when exhausted (share) |
| 2 | A fake `error_max_turns` result ends the run `waiting_continuation` with its session stored; a queued run of the same bot and thread waits; `error_max_budget_usd` and a crash still end `failed` | T1 `packages/gateway/src/scheduler/continuation.test.ts`; T2 `acceptance/m4-turn-exhaustion.container.test.ts` ("items 2-3", real SDK `error_max_turns`, session and sidecar handoff file checked; the queued-run, budget and crash clauses stay T1): **pass** 2026-10-09, 0.1 s after the park, image `sha256:c4258dab7de4`, source `cc60cd4`. Real model: not run | exhausted runs per day (reported) |
| 3 | The request is a `system` message with bot, delegating message, turns, tokens and handoff path and no page text; only the delegator is woken; with a human delegator no bot is woken | T1 same file; T1 router test; T2 `acceptance/m4-turn-exhaustion.container.test.ts` ("items 2-3", bot delegator; the human-delegator clause stays T1): **pass** 2026-10-09, same case as item 2, image `sha256:c4258dab7de4`, source `cc60cd4`. Real model: not run | none |
| 4 | `continue` resumes attempt 2 with `resume: sessionId` and a fresh budget; `stop` ends `stopped` with the handoff as `done`; 24 hours without an answer is `stop` (fake clock) | T0 `packages/gateway/src/approvals/continuation-decision.test.ts` for decisions and cap; planned T1 continuation journey for the expiry sweep; T2 `acceptance/m4-turn-exhaustion.container.test.ts` ("item 4", `continue` by the delegator bot through `approval_decide`; `stop` and expiry are not in the T2): **pass** 2026-10-09, 1.2 s / 2.1 s, image `sha256:c4258dab7de4`, source `cc60cd4`; attempt 2 keeps the parked SDK session id, its first request carries attempt 1's 12 tool turns, and it ends `succeeded` in one turn of the fresh budget. Real model: not run | continued runs that then succeed (share) |
| 5 | A third exhaustion ends the run `failed` and posts a final notice | T1 same file | none |
| 6 | Continuation messages do not move `turn_budget` or `relay_count`; token usage per attempt sums to the run total | T0 `packages/gateway/src/ledger/usage.test.ts` for no-thread cumulative accounting; planned T1 router check for message caps | none |
| 7 (amendment 1) | A run woken by a bot-authored message that mentions its bot, from a bot upstream of it in the wake chain, is a delegation; its delegator is that message's author, read through `runs.trigger_ref`; a run woken by a human, by a system message, by a walk of an unaddressed message, or by a report from a bot downstream of it is not | T1 `packages/gateway/src/threads/delegation-outcomes.test.ts` ("names the delegator", "human delegator", "the delegator's silent read of a reply is not announced", "a second delegation down the same chain", "a walk of the chief's unaddressed summary offers"); T0 `evals/delegation-metrics.test.ts` ("does not count a report up the chain") | delegation chains per day (reported by `evals/delegation-metrics.ts`) |
| 8 (amendment 1) | When the delegate run ends `succeeded`, `silent`, `failed` or `stopped`, exactly one `system` message is posted in the delegation's thread; it names the delegate, the outcome and, per outcome, the reply's seq, the bounded error or the handoff path; it wakes the delegator and nobody else; a wake already queued for the delegator is coalesced, not doubled | T1 same file (one case per outcome, including the crash path through `RunLifecycle.fail`; the succeeded case checks the reply's own wake is not doubled); T2 `acceptance/m4-turn-exhaustion.container.test.ts` ("item 8", the `succeeded` outcome of a continued run only): **pass** 2026-10-09, 2.8 s / 3.6 s (includes a 2 s quiet window), image `sha256:c4258dab7de4`, source `cc60cd4`. Real model: not run | missed replies and stuck delegators, both 0 after this amendment (`evals/delegation-metrics.ts`) |
| 9 (amendment 1) | A `message_bot` delegation whose delegating run sits in another thread gets the same notice in that thread, with the reply wrapped as untrusted bot text and a link to the bus thread; the bus thread keeps ADR-0005 routing | T1 same file ("cross-thread handoff"); T0 `packages/sidecar/src/memory-taint.test.ts` (a system message carrying wrapped bot text taints the run) | wall time from delegation to notice, chat-thread delegations (`evals/delegation-metrics.ts`) |
| 10 (amendment 1) | Every notice is a `log` event `{source: "delegation_outcome"}` on the delegate run naming the notice message ids, so the metrics are computable from the ledger alone | T1 same file; T0 `evals/delegation-metrics.test.ts` | none |
| 11 (amendment 1) | In a paused thread, or when the delegating message's `relay_count` is at `RELAY_COUNT_MAX`, the notice is appended and wakes nobody; an adversarial ping-pong still ends at six runs | T1 same file ("paused thread", "relay cap"); T1 `packages/gateway/src/m2-group-foundation.test.ts` ("caps an explicit bot ping-pong") | none |
| 12 (amendment 1) | `cancelled` posts no notice; `turns_exhausted` keeps decision 3's request as its notice | T1 same file ("cancelled") ; decision 3's tests | none |

## Consequences

- `contracts` gains the `turns_exhausted` outcome, the `waiting_continuation` and `stopped` statuses and the `continuation` approval kind; a migration adds them and the continuation count.
- The UI shows exhausted runs in the approval inbox with the handoff.
- Chief-style SOULs should say what to do with a continuation request; that is a strategy change and is measured, not assumed.
- The board trial's stuck-task problem gets its product answer here; until this ships, the spike's daemon can only mark a delegated item stalled when the Gateway reports its run failed, without waking anyone.

## Amendment 1 (2026-09-30): every terminal outcome of delegated work reaches the delegator

Decisions 1 to 6 cover one way a delegated run can end without telling anyone: running out of turns. The M2 closeout and the six-hour soak (`docs/design/m2-final-closeout-2026-09-24.md`, `docs/design/m2-six-hour-soak-results-2026-09-25.md`) and the board trial show the other ways, and they are the common ones:

- A delegate run that ends `failed` (a crash, the wall-clock deadline, a sandbox error, a start failure) posts nothing and wakes nobody. The delegator waits.
- A delegate run that ends `silent` posts nothing by definition. The delegator cannot tell "not done yet" from "done and said nothing".
- A `message_bot` handoff from a `chat` thread is answered in the pairwise `bus` thread (ADR-0005 item 5). The delegator's task, and its SDK session for that task, live in the chat thread; the reply reaches a different session on the background lane, and the chat thread only ever sees "handed off to X".
- A `succeeded` reply does reach the delegator, but as an ordinary bot message among others; nothing says which delegation it closes.

The product owner's decision on 2026-09-30 narrows the first step to exactly this: make every outcome reach the delegator, in the thread it delegated from, and make failures visible. An explicit waiting primitive (a `thread_wait` tool that parks the delegating run) is a later, separately measured experiment and is not part of this amendment. A delegation id, a `Stop`-hook check of claimed delegations, SDK sub-agents and cheap-model triage are also out of scope; the existing message-to-run linkage is enough. Nothing here can fix a delegator that claims to have delegated without calling a tool; that failure is measured separately and is not attributed to this change.

7. **A delegation is a bot-authored thread message that explicitly mentions, and so wakes, a bot further down the wake chain.** Its delegator is the message's author, read through `runs.trigger_ref` → `thread_messages.author_id`. A run woken by a human message or by a `system` message is not a delegation; a human delegator sees the run's status in the UI and gets no thread notice. No new identifier is introduced.

   The mention matters. Work is delegated by addressing someone (`message_bot` always does). A bot woken by the in-turn walk of an unaddressed or `@everyone` message was offered the message, not given a task, and "may stay silent" (ADR-0005 item 4). Without this rule the chief's own final summary, which mentions nobody and is walked past every expert, would come back as one "expert ended silently" notice and one chief wake per expert; this was found by reading the chief acceptance case against the rule, before any model run.

   Direction matters, because a delegate's report ("done @chief") is structurally the same thing as a delegation: a bot message that wakes another bot. The wake chain of a run is the list of bots reached by following `runs.trigger_ref` and `thread_messages.run_id` upward until a human message, a system message or a cron/webhook trigger. The bot that first appears earlier in that chain is upstream. Work flows down the chain and reports flow up it; only the downward hop is a delegation. So the chief's read of an expert's reply is not announced back to the expert (it would cost one wasted run per delegation, which the scripted ledger showed before this rule was added), while the chief's second assignment to the same expert, further down the same chain, still is.

8. **Every terminal outcome is announced to the delegator, once.** When the delegate run ends `succeeded`, `silent`, `failed` or `stopped`, the Gateway posts one `system` message in the delegation's thread and wakes the delegator only, exactly as decision 3 does for a continuation request. The notice names the delegate, the outcome and the delegating message's seq, then per outcome: the seq of the reply message (`succeeded`; the reply itself is delivered in the same slice, so it is not repeated), "no reply was posted" (`silent`), the run's error text bounded to 300 characters (`failed`; the sidecar's own error, never page text), or the handoff path (`stopped`, decision 4). `turns_exhausted` keeps decision 3's request as its notice. A wake already queued for the delegator in that thread coalesces with the notice (ADR-0005 item 8), so a reply that mentions the delegator does not produce two runs.

9. **A `message_bot` delegation is announced where it was made.** When the delegating run's thread is not the bus thread the message was posted in, the same notice is also posted in the delegating run's thread, waking the delegator there. That session cannot see the bus thread, so this notice carries the reply text, bounded to 4000 characters and wrapped by the Gateway as untrusted bot text with the same wrapper the sidecar applies to bot messages (`wrapUntrusted`, moved to `contracts` so both packages use one implementation), plus a link attachment to the bus thread. The sidecar's taint tracker treats a `system` message carrying that wrapper as `other_bot` content (ADR-0011 decision 3). The bus thread keeps ADR-0005 item 5 routing: a reply there that mentions the delegator still wakes it on the background lane. That second wake is a measured cost of this amendment, not a defect it fixes; suppressing it is a later knob.

10. **Every notice is in the ledger.** Posting a notice appends a `log` event `{source: "delegation_outcome", outcome, delegatorBotId, messageIds}` to the delegate run, so missed replies, stuck delegators and delegation-to-notice wall time are computable from the ledger alone (`evals/delegation-metrics.ts`).

11. **The caps still stop the chain.** A notice into a thread paused by a `turn_budget` breach is appended for the human to read and wakes nobody; the next human message resets the thread (ADR-0005 item 6). The same holds when the delegating message was already at the `relay_count` cap: the delegate was woken at the cap, anything it sends back is past it, and a notice that woke the delegator would be the very hop the cap refuses. The notice is a `system` message and counts toward neither cap, but it does not get to walk around one.

12. **`cancelled` is not announced.** A queued delegate run cancelled by a turn-budget pause never ran, and the pause alert already names the mentions it dropped. An operator cancellation of a live run is visible in the UI. This keeps the notice set to outcomes of work that was actually attempted.

Alternatives considered for this amendment:

- Deliver the reply as a bot message in the delegating thread: rejected. The delegate is not a member there, the message would count against `turn_budget` and `relay_count`, and it would need a membership exception that ADR-0005 does not have.
- Post the notice only in the bus thread for `message_bot`: rejected. It is the case that motivated the amendment; the delegator's session for the task is in the chat thread.
- Suppress the bus-thread wake once the chat thread gets the notice: deferred. It changes ADR-0005 item 5 and is a wake-cost knob to measure, not a correctness fix.

Consequences of this amendment: `packages/gateway/src/threads/delegation-outcomes.ts` is the one place that decides whether a run was a delegation and what to post; `RunLifecycle.ended`, `RunLifecycle.fail` and the continuation `stop` path call it. `contracts` gains `wrapUntrusted`. The acceptance criterion for the amendment is not "the chief passes 9/9" but the six ledger metrics in `evals/delegation-metrics.ts`, compared before and after on the same cases.

Clarification of decision 8 (2026-09-30, evening): **a `silent` run that posted through `thread_post` did reply.** `silent` means the final `reply` was empty. A delegate that posted its answer with `thread_post` and then ended with nothing to add was announced as "ended the work … without posting a reply (silent)", which is false; on a real model the delegator read it, concluded something had gone wrong and posted a correction that woke the delegate again (`docs/design/group-owner-routing-results-2026-09-30.md`). The notice for such a run now reads "finished the work … Its reply is message #N", the `message_bot` notice quotes that reply, and the ledger event carries `replied: true` next to `outcome: "silent"`. A `silent` run that posted nothing is announced as before. Test: `threads/delegation-outcomes.test.ts`, "silent after a thread_post".

Second clarification of decision 8 (2026-09-30, evening): **work that is handed on is announced when it is answered, not when the first run ends.** Two cases the amendment's text did not cover, both found in review of ADR-0005 amendment 2:

- A delegate whose last message in the delegation's thread mentions a bot other than its delegator has handed the work on; that message is not its answer. Announcing it as "finished … Its reply is message #N" was wrong for a `succeeded` run before this change and became wrong for a `silent` one with the first clarification.
- A delegate that hands part of its work to a third bot is woken again by that bot's outcome notice. The run the notice wakes was not woken by a bot, so by decision 7 it is no delegation, and its answer was announced to nobody. Under `walk-v1` the walk of the unaddressed answer reached the first delegator by accident; under `owner-v1` an unaddressed bot message wakes nobody (ADR-0005 decision 17), so the answer would have stopped there.

The rule now: a run *works on* a delegation if it is the delegation's run, or if it was woken, in the delegation's thread, by word of a delegation made by a run working on it (`workOf`). Word is the Gateway's outcome notice or the teammate's own report, a message that mentions the delegate; wakes coalesce (ADR-0005 item 8), so whichever is queued first is the one the run is woken by. Every notice carries the run it is about in `thread_messages.run_id`, which is the only new link. When a run working on a delegation ends `succeeded` or `silent` with no answer, and either another run of the same bot on the same work is not terminal or a bot it handed part of the work to has not finished, nothing is announced and a `log` event `{source: "delegation_outcome_deferred"}` is written: the delegate will be woken again, and that run's end is announced. Otherwise the outcome is announced, read from the last thing the delegate said on the work in any of its runs: an answer is "finished … Its reply is message #N", a hand-on with nothing left open is "ended the work … after handing it on in message #N; no reply was posted". A later run that added nothing to work whose outcome was already announced is not announced again (`reason: "nothing_new"`). `failed` and `stopped` are always announced. The delegation metrics key a notice by the delegating message, not by the run it was logged on. Tests: `threads/delegation-outcomes.test.ts`, "work that is handed on".

Third clarification of decision 8 (2026-10-01): **a delegate that reported by mentioning its delegator has already woken it; the notice is then posted without a wake.** Wakes coalesce only while the earlier one is queued (ADR-0005 item 8). A delegate that posts "@chief done" with `thread_post` and ends a moment later finds the chief's run for that message already running, so the notice queued a second run with nothing new to read. `acceptance/m2-group-limits.container.test.ts` counted it: seven runs instead of six in the relay loop, on `main` since the amendment landed, found when the T2 tier was run for ADR-0005 amendment 2. When the work's last word mentions the delegator, the notice in the delegation's thread is appended and wakes nobody. The notice in the delegating chat thread of a `message_bot` handoff still wakes: the mention was heard in the bus thread only. `failed` and `stopped` have no reply and always wake. Test: `threads/delegation-outcomes.test.ts`, "a delegate that reported by mention".

Clarification of decision 7 (2026-10-01): **a run's delegations are read from what it was delivered, and the wake chain follows a notice.** Two defects found in review of the clarifications above, both reproduced with tests before the fix:

- A delegation posted while its delegate already had a run queued in the thread coalesces into that run (ADR-0005 item 8), so no run's `trigger_ref` names it. The open-work check of decision 8 saw no run for the hand-on, announced "handed it on; no reply" at once, and when the queued run answered nobody was told: under `owner-v1` an unaddressed answer wakes nobody. Now `RunLifecycle.start` stamps `deliveredFromSeq` next to `deliveredSeq`, and a run's delegations are every message in that slice that delegates to its bot (`delegationsOf`); a run delivered two delegations works on both and is announced to both delegators. A queued run of the mentioned bot, or a live one that was delivered the hand-on, keeps the work open. A run row from before the stamp has only its trigger to go on.
- A delegate woken by an outcome notice and reporting up with a mention was taken for a delegator: the chain walk stopped at the system message and lost the delegator above. The chain now follows a notice through the run it names, so the delegate's report reads as a report, and the delegator's silent read of it is announced to nobody.

The direction rule is unchanged: first appearance in the chain of the posting run decides who is upstream. The delegation metrics mirror both. Tests: `threads/delegation-outcomes.test.ts`, "a hand-on that coalesced", "two delegations at once", "a report after a notice-woken continuation".

## Verification state (2026-09-30)

Targeted unit tests for the turn warning, start/end protocol parsing, run state transitions and migration passed. The migration check seeds a dependent browser-origin queue row and run event, then confirms both survive the `runs` table rebuild with foreign keys enabled. Backend and Web typechecks passed. The ADR's T1 continuation journey, SDK T2 hook behavior and real-model handoff quality were not run under the owner's instruction to reserve integration and end-to-end testing for a later pass. The implementation is therefore not a milestone acceptance claim.

## Verification state (2026-10-09): T2

`acceptance/m4-turn-exhaustion.container.test.ts` runs items 1, 2, 3, 4 and 8 as one journey on the real stack with a scripted upstream and no model: a chief bot delegates by mention to a worker in one thread, the worker calls `Bash` on every turn with `maxTurns` 12, writes a handoff with `Write` once the warning arrives, exhausts, parks, is continued by the chief through `approval_decide`, replies, and the chief is woken by the outcome notice. Items 5, 6, 7 and 9 to 12 and the clauses noted in the table stay T0/T1 only.

- Source: `cc60cd4957ffe6d6e7981f3eaa5e8f866fca260b` (runtime unchanged; the commit recording this adds the test file).
- Workspace image: `deskmates/workspace:arm64-abe907470894`, image ID `sha256:c4258dab7de43efa4d31720c827a33b8f1bf80b7ac3c2923ed8e3826933c3ca1` (app layer built locally from that source on base `deskmates/workspace-base:arm64-afd228b644f2`; Agent SDK 0.3.278 in the image). Local build, so there is no registry digest; the ID is the digest of the image config.
- Egress proxy image: `deskmates/egress-proxy:arm64-7d91517883a7`, `sha256:625ee0e145b3299366d8fc7ff45bf95853d806ab8f39f2e5d4d66b3d123a319f`.
- Host: workstation Docker on colima (4 CPUs, 8 GiB), shared with other work. Command: `DESKMATES_SKIP_IMAGE_BUILD=1 WORKSPACE_IMAGE=<image ID> EGRESS_PROXY_IMAGE=<proxy tag> npx vitest run acceptance/m4-turn-exhaustion.container.test.ts`.
- Result: 4/4 cases passed in each of two consecutive runs (file wall time 15.2 s and 17.3 s including stack start).

Real-model acceptance (handoff quality, the share metrics of items 1 and 4) was not run; it needs a separately approved campaign.

## Amendment 2 (2026-10-14): the turn cap and the continuation limit are workspace settings, frozen per run

Status: Owner-decided (2026-10-14; issue #61). Decisions 1 to 6 keep their defaults; ADR-0005 amendment 5 does the same for the message caps and adds the loop breaker. The owner ruled on 2026-10-14 that `off` no longer needs a money budget unless the workspace turns on "require a budget for unlimited limits" (decision 15 as revised).

The per-attempt turn cap is one Gateway value (`DESKMATES_MAX_TURNS`, default 80 since issue #69), and decision 5's limit of two continuations and decision 4's 24-hour answer window are code constants (`scheduler/run-lifecycle.ts`, `approvals/broker.ts`). The owner asked on 2026-10-13 that long work be governed by money and time policy and the user's Stop instead of fixed counts, once the money backstop exists; ADR-0032 is that backstop and left these counts unchanged (its decision 10). Issue #61 asks for named, validated operator settings with documented precedence, an explicit way to switch turn counting off where the pinned SDK allows it, frozen values on resume, and the effective values in the ledger.

13. **Three workspace settings.** `maxTurns` (1 to 1000, or `off`), `continuationLimit` (0 to 20, or `off`) and `continuationWindowHours` (1 to 168). They are stored, validated, permissioned and audited with ADR-0005 amendment 5's settings (decision 37 there: Owner or Admin, one `workspace.limits_set` audit row per change). A new workspace stores none of them.

14. **Precedence.** `maxTurns`: the workspace setting, else `DESKMATES_MAX_TURNS`, else 80. `continuationLimit`: the workspace setting, else 2. `continuationWindowHours`: the workspace setting, else 24. Runs that are model jobs (approval presentations, activity summaries, probes, SOUL proposals) keep their own fixed `maxTurns` of 1 and are not affected.

15. **What `off` and 0 mean.** `maxTurns` `off` omits the SDK option (`maxTurns` is optional in SDK 0.3.278), so the sidecar gives no turn warning and the run never ends `turns_exhausted`; the wall-clock deadline, the workspace budget and Stop still bound it. `continuationLimit` 0 ends the first exhaustion `failed` with the final notice of decision 5, without asking; `off` asks on every exhaustion and never fails for the count. A continuation is never automatic, whatever the limit. `off` follows ADR-0005 amendment 5 decision 39 (owner, 2026-10-14): it is accepted without a monetary limit; only while the workspace switch `requireBudgetForOff` is on is it refused without one, and a stored `off` then resolves to the default with source `default_no_backstop` until a limit is set or the switch is turned off.

16. **Frozen when the run first starts.** When attempt 1 starts, the Gateway resolves the three values and writes them to `runs.config_json` (`maxTurns`, `continuationLimit`, `continuationWindowHours`, plus `limitSources` naming `workspace`, `gateway`, `default` or `default_no_backstop` for each, and `limitsVersion: 1`). Approval resumes, continuations and budget continuations read the frozen values, so a settings change applies to runs that start afterwards. Changing the frozen limits of a parked run is not provided; if it is wanted, it is an explicit, audited action tied to the durable checkpoint identity of issue #63, not a side effect of a settings change.

17. **The decision point says what limit it hit.** The continuation request names the attempt cap with its source and the continuations left ("1 of 2 left", or "no continuation limit"), and its `continuation_requested` event carries `continuationLimit` (null for `off`) and `continuationWindowHours`. The approval's expiry is the frozen window.

18. **No default changes here.** Changing 80, 2 or 24, or making `off` a default, is proposed and not decided: it is a strategy change and needs a paired run against the current baseline (`evals/compare.ts`, per duration bucket) that measures useful artifacts completed and spend. Raising a cap is not evidence of improvement by itself.

Not in this amendment: the per-attempt wall-clock timeout (`RUN_TIMEOUT_SECONDS`, 1800 s) stays a Gateway value, and a timed-out attempt still ends `failed`; a durable checkpoint for the timeout and the SDK-exit cases reported on issue #61 belongs to #63.

Alternatives considered for this amendment:

- Re-read the workspace setting on every resume: rejected. A run would change its rules half-way, and a resumed attempt could not be compared with the first.
- Per-bot or per-task turn caps: deferred. The workspace is the money domain, and nobody has asked for per-bot values; a later knob can sit above the workspace in the precedence list.
- Make `maxTurns` `off` the only setting and drop the continuation limit: rejected for the same reason as ADR-0005 amendment 5 decision 42.

### Verification (amendment 2)

| Item | Concrete meaning | Test | Metric |
|---|---|---|---|
| 13 (amendment 2) | the three settings validate their ranges, accept `off` without a monetary limit unless `requireBudgetForOff` is on, and write one audit row per change | T0 `packages/gateway/src/limits/workspace-limits.test.ts`; T1 `packages/gateway/src/api/limit-routes.test.ts` | limit changes per week (audit) |
| 14 (amendment 2) | with no setting the StartRunRequest carries the Gateway's `maxTurns`; with `maxTurns` 12 it carries 12 and `limitSources.maxTurns` is `workspace`; a model job still carries 1 | T1 `packages/gateway/src/scheduler/continuation-limits.test.ts` | none |
| 15 (amendment 2) | `maxTurns` `off` sends `null` and the sidecar passes no SDK `maxTurns` and gives no warning; `continuationLimit` 0 fails the first exhaustion with no request; `off` asks a third time where the default would fail | T1 `continuation-limits.test.ts`; T0 `packages/sidecar/src/turn-warning.test.ts`, `packages/sidecar/src/start-run-request.test.ts` | exhausted runs per day by limit source |
| 16 (amendment 2) | a setting changed while a run is parked does not change that run's resumed `maxTurns`, limit or window; attempt 2 carries attempt 1's frozen values | T1 `continuation-limits.test.ts` | none |
| 17 (amendment 2) | the request text names the cap, its source and continuations left; the event carries the limit and the window; the approval expires after the frozen window | T1 `continuation-limits.test.ts` | none |
| 18 (amendment 2) | the defaults are unchanged: the existing continuation tests pass without edits | T1 `packages/gateway/src/scheduler/continuation.test.ts`; T0 `packages/gateway/src/approvals/continuation-decision.test.ts` | paired campaign required before any default change |
