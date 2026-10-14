# Group owner routing: results

Date: 2026-09-30
Status: implemented on branch `group-owner` (worktree `.claude/worktrees/group-owner`), not on `main`, not deployed. Deterministic gates pass on the branch. Real-model runs on Testbox, all on 2026-09-30: a smoke, a first paired campaign on the code before review, a second on the code after review, and a two-pair confirmation on the head. Not a milestone acceptance.
Decision record: ADR-0005 amendment 2 (decisions 12 to 19); ADR-0016 amendment 1, clarifications of decision 8.
Base: `main` at `6bfe51e`.

## What was asked

The product owner, 2026-09-30: a bot should step up as chief on its own when a task is posted without naming one, as in Grok Bot, instead of the human writing `@chief`. Then, as a goal: in multi-bot work, bots delegate on their own and pass work and information between them.

Research before any code found that Grok Bot's documentation describes no election. It wakes each member in turn, which is what ADR-0005 decision 4 copied, asks the human to "describe the shared outcome and who owns the next step", and recommends "a single owner at each stage". Deskmates had copied the routing and none of the context: a woken bot was not told who else was in the thread or what any of them was for, the walk went on after somebody answered, every unaddressed bot reply walked the group again, and a request every member passed on produced nothing.

## What changed

One knob, `DESKMATES_GROUP_ROUTING`, recorded on every run as `groupRouting`: `walk-v1` is decision 4 as first written; `owner-v1` is the new routing. Under `owner-v1`, in a chat thread with more than one member:

- A wake carries the roster: every member in join order with its `role`, which one is the recipient, which one is the owner, and for an offered request who was asked before and who is next (routing context version 2).
- The sidecar states a group norm in the system prompt: take an offered request, hand it to a better-suited member by mention, or end with an empty reply; the taker answers the human and acts on delegation outcome notices.
- An unaddressed human message is offered to one member at a time, the owner first, and the offer ends when the member it woke posts anything.
- The taker is recorded as the thread's owner (`threads.owner_bot_id`). A human who addresses exactly one bot in a thread with no owner also names it.
- An unaddressed bot message wakes nobody. `@everyone` still walks every member.
- An offer every member passed on ends with one system line, "No member replied to message #N: …".

Under both routings:

- `thread_post` answers with the message's seq, whom it addressed, and what looked like an address and was not (decision 19).
- Delegation outcome notices follow work that is handed on (ADR-0016): a delegate that answered through `thread_post` is announced as having replied; a delegate that handed part of the work to a third bot is announced when its own answer is in, not before; the outcome is announced once.

Also: migration `0022`; the web composer says where an unaddressed message will go and the member list marks the owner; `evals/delegation-metrics` reports what unaddressed requests cost; `acceptance/m3-group-owner` is the real-model case; `spikes/group-owner/run-routing-ab.sh` runs one build under both knob values.

## Deterministic verification

On the branch head: `npm run typecheck` passes, `npm run lint` passes (642 files), `npm test` passes (220 files, 2315 tests; `main` had 218 files and 2245 tests). New tests, by decision:

| Decisions | Test file |
|---|---|
| 14 to 18, the knob | `packages/gateway/src/threads/group-owner.test.ts` (23 cases at the router) |
| 12, 13, 17, 19 through the Gateway | `packages/gateway/src/m2-group-foundation.test.ts` (roster and norm in the wake, delegation back through the notice with no member walked, `thread_post` routing answer, `walk-v1`) |
| 12, 13 in the sidecar | `packages/sidecar/src/context.test.ts`, `start-run-request.test.ts`, `posted-message.test.ts` |
| 13 on resume | `packages/gateway/src/scheduler/run-lifecycle.test.ts` |
| ADR-0016 clarifications | `packages/gateway/src/threads/delegation-outcomes.test.ts` ("work that is handed on", 9 cases, and "a delegate that reported by mention") |
| metrics | `evals/delegation-metrics.test.ts` |
| web | `packages/web/src/screens/mention-query.test.ts`, `mention-textarea.test.tsx`, `membership.test.tsx` |

The T2 container tier was run on Testbox against the campaign image, first at `e01f7de` and again at `b517d93`, the last code commit. At `b517d93`, 24 of 25 files pass; of 85 tests, 82 pass, one is skipped and two fail. The two that fail, both in `m2-boundaries.container.test.ts`, are the ones that fetch a public site through the egress proxy; they fail identically on the base tree with its own image, and the egress code is untouched here, so they are that host's network on that night, not this change.

The first T2 run found two things the T0/T1 gates could not:

- **A regression already on `main`.** `m2-group-limits` counts the runs of a two-bot relay loop and found seven where six are allowed. The base tree fails the same way. The delegation outcome notice, landed on 2026-09-30 without a T2 run, wakes a delegator that its delegate had already woken with "@chief done" whenever that first run is already under way. Fixed here: the notice is posted without a wake when the work's last word mentions the delegator (ADR-0016, third clarification). It also removes one run from most delegations in the campaigns below.
- **`m2-group-silence`** asserted that an unaddressed message both members pass on leaves one message in the thread. Under `owner-v1` there are two, the second being decision 18's line. The test now asserts the routing in force.

An independent read-only review of the Gateway, contracts, sidecar and metrics diff was run before the final campaign. It confirmed three defects with throwaway tests, all fixed before the final campaign: a `message_bot` delegate that answered through `thread_post` was called silent and quoted in the same notice; a delegate that only handed the work on was announced as having replied, and its real answer in a later run was announced to nobody; a member skipped in an offer was credited with taking it on the strength of a message written before it saw the request. Smaller findings fixed at the same time: owner routing and the roster are for chat threads only, a run row with no knob is delivered as the walk routed it, a removed member is still named, and two miscounts in the offer metrics.

## Real-model method

Host: Testbox, campaign directory `~/agent_workspace/deskmates-reusable-group-owner-20260930`, under the host's heavy-test lock, load average below 1 throughout. Model: `glm-5.3` (cheap model `glm5.3-flash`) through the internal endpoint, the same as the earlier campaigns. Workspace base `deskmates/workspace-base:amd64-afd228b644f2`, egress proxy `deskmates/egress-proxy:amd64-7d91517883a7`. Each source tree was shipped as a `git archive` and its sha256 checked on arrival. The stable deployment was not touched.

One build and one image per campaign. The arms differ only in `DESKMATES_GROUP_ROUTING`, alternate, and get one attempt per repetition with no retries.

| Run | Commit | Source tar sha256 | Image id | Window (UTC) |
|---|---|---|---|---|
| Smoke, `owner-v1` only, 1 repetition | `18669ab` | `dad680bf…a7f4` | `sha256:dd98114e…0c79` | 14:03:53 to 14:06:06 |
| Aborted attempt, 1 pair | `ebc8a6c` | `f4d3ec91…f31b` | `sha256:6b07b967…e47c` | 14:09:04 to 14:13:55 |
| Campaign A, 3 pairs, 3 scenarios | `1b9d76e` | `a718f43f…0a26` | same image | 14:14:39 to 15:07:13 |
| Campaign B, 4 pairs, 4 scenarios, then the foundation suite, 4 pairs | `e01f7de` | `8913372a…a96e` | `sha256:a96a5da3…7d21` | 15:13:40 to 16:03:34 |
| Confirmation on the head, 2 pairs of each suite | `b517d93` | `631d6ad5…f1e3` | same image | 16:26:33 to 16:43:44 |

The case, `acceptance/m3-group-owner.acceptance.test.ts`: three bots with a role and one private fact each and no scripted protocol. `g_prices` knows unit prices, `g_lead` plans and holds no data, `g_stock` knows stock counts. The join order puts `g_prices` first, so the member offered first is not the natural coordinator. Limits: 8 turns and 180 s per run.

| Scenario | Request | Oracle |
|---|---|---|
| combine | unaddressed: "what is the total stock value of item K?" | a bot posts `STOCK_VALUE=425` |
| follow-up | unaddressed, same thread: "and the same for item M?" | `STOCK_VALUE_M=120` |
| single | unaddressed, fresh thread: "how many units of item Q are in stock?" | `STOCK_UNITS_Q=61` |
| relay (campaign B only) | fresh thread: "@g_lead what is the total stock value of item R?" | `RELAY_VALUE=63` |

"Answered" is the oracle. "Passed" is answered with no failed run. The decision rule was written after the smoke and the aborted pair and before campaign A: `owner-v1` becomes the default if it answers at least as often as `walk-v1` on these scenarios within what a handful of repetitions can show, costs fewer runs, and the foundation suite shows no loss beyond the two or three failures per 36 the earlier campaigns saw from upstream stalls.

## The smoke and what it changed

The smoke answered all three scenarios and showed four things, each fixed before campaign A:

1. **A false "silent" notice.** `g_stock` answered through `thread_post` and ended with an empty reply; the notice told `g_prices` it "ended the work … without posting a reply (silent)". `g_prices` then posted a correction that mentioned `g_stock` again, which woke it, and so on: 8 runs for one question.
2. **Attribution with `@`.** The final answer read "(from @g_stock)", which is a mention and woke `g_stock` for nothing.
3. **The answer posted twice**, once with `thread_post` and again as the final reply.
4. **A delegate mentioning its delegator**, which wakes it once before the notice does.

The notice was corrected (ADR-0016) and the norm gained three sentences. The norm was therefore revised once on the evidence of the case it is measured by; the smoke is not counted in any result below.

The aborted pair showed that a bot carries facts between threads through learned memory: in the fresh thread `g_prices` answered item K's stock count, which it had learned in the first thread. The single scenario now asks about an item no other thread mentions. The pair is kept on the host as `out-owner-attempt1-contaminated-single` and is not counted.

## Campaign A: code before review, 3 pairs

| Scenario | Routing | Answered | Passed | Mean runs | Mean s to answer | Mean input tokens | Mean output tokens | Mean cache read |
|---|---|---|---|---|---|---|---|---|
| combine | walk-v1 | 3/3 | 3/3 | 7.3 | 37.3 | 24845 | 3066 | 232277 |
| combine | owner-v1 | 3/3 | 3/3 | 3.3 | 28.6 | 10841 | 1205 | 106667 |
| follow-up | walk-v1 | 2/3 | 2/3 | 4.0 | 19.0 | 13878 | 1003 | 145749 |
| follow-up | owner-v1 | 3/3 | 3/3 | 3.7 | 17.8 | 11690 | 657 | 124075 |
| single | walk-v1 | 3/3 | 1/3 | 8.7 | 352.1 | 30077 | 1969 | 171349 |
| single | owner-v1 | 2/3 | 2/3 | 2.3 | 20.9 | 8952 | 866 | 80725 |

The three observations that were not answered, and the two that were answered with failed runs:

- **`owner-v1`, single, repetition 3: a hand-off that woke nobody.** `g_prices` took the request and wrote "@ g_stock — I'm taking the stock-count question…", with a space after the `@`. That is not a mention. Under `owner-v1` the message woke nobody, the offer had ended with it, and the request stopped there after one run. Under `walk-v1` the walk would have carried it to `g_stock`. This is the failure the amendment's consequences name, observed once in nine `owner-v1` observations. Decision 19 and one sentence in the norm were added because of it.
- **`walk-v1`, follow-up, repetition 3: a thread stuck behind an approval.** In the combine scenario `g_prices` and `g_lead` each asked approval for `ListAgents`, a tool to find out who their teammates are. Nobody was there to approve; `g_lead`'s run stayed parked and its next run stayed queued behind it. The follow-up question created no run in nine minutes. All three `walk-v1` combine observations contain such an approval card; no `owner-v1` observation in any campaign does.
- **`walk-v1`, single, repetitions 1 and 3: runs killed at 180 s.** Two and three runs ended `failed` with "run exceeded RUN_TIMEOUT_SECONDS". In repetition 1 `g_lead` had posted a request to `g_stock` without an `@` and its run then lasted until it was killed. Whether these runs were waiting inside the run or the upstream stalled cannot be told: the ledgers of a campaign stack are deleted with the stack, and the runs have no usage rows, so their tokens are unknown.

## Campaign B: code after review, 4 pairs

| Scenario | Routing | Answered | Passed | Mean runs | Mean silent runs | Mean s to answer | Mean input tokens | Mean output tokens | Mean cache read | Runs without usage |
|---|---|---|---|---|---|---|---|---|---|---|
| combine | walk-v1 | 4/4 | 4/4 | 7.3 | 4.5 | 43.4 | 22708 | 2313 | 193408 | 0 |
| combine | owner-v1 | 4/4 | 4/4 | 4.0 | 3.8 | 13.0 | 12415 | 1306 | 120576 | 0 |
| follow-up | walk-v1 | 4/4 | 4/4 | 7.0 | 4.3 | 17.8 | 11255 | 1553 | 233472 | 0 |
| follow-up | owner-v1 | 4/4 | 4/4 | 4.0 | 3.8 | 7.9 | 12763 | 723 | 126848 | 0 |
| single | walk-v1 | 4/4 | 4/4 | 8.0 | 4.8 | 8.5 | 42410 | 3329 | 251136 | 2 |
| single | owner-v1 | 4/4 | 4/4 | 3.3 | 3.0 | 7.6 | 16133 | 1079 | 101632 | 0 |
| relay | walk-v1 | 4/4 | 4/4 | 8.5 | 6.3 | 17.5 | 41325 | 2522 | 282624 | 2 |
| relay | owner-v1 | 4/4 | 4/4 | 5.5 | 4.0 | 14.9 | 18937 | 1292 | 163584 | 1 |

Totals over the sixteen observations of each arm:

| | walk-v1 | owner-v1 |
|---|---|---|
| Answered | 16/16 | 16/16 |
| Runs | 123 | 67 |
| Input tokens | 470790 | 240992 |
| Output tokens | 38869 | 17595 |
| Cache read tokens | 3842560 | 2050560 |
| Runs with no usage row (tokens unknown, not in the totals) | 4 | 1 |
| Observations with an approval asked | 4 | 0 |
| Observations that reached the turn budget | 4 | 1 |
| Runs left parked or queued | 2 | 0 |
| Hand-offs that woke nobody | 0 | 0 |

What the transcripts show:

- **Who stepped up.** Under `owner-v1` the member offered first, `g_prices`, took all twelve unaddressed requests and became the owner. For the two-specialist questions it asked `g_stock` for the count by mention, was told by the notice, and answered. For the stock-count question it handed the request to `g_stock`, who answered. `g_lead`, the bot whose role says it coordinates, was never needed for an unaddressed request: the first member offered takes the work whatever its role. That is the join-order bias the amendment expected. It did not cost an answer here.
- **The relay.** Named by the human, `g_lead` asked both specialists in one run, ended it, was woken by the two notices and posted the total. Five runs in three of four repetitions.
- **Under `walk-v1`** the same bots reach the answer through the walk: each member adds what it knows and a later one computes. It takes seven to eight runs, the answer is often posted by whoever spoke last, and in four of sixteen observations a bot asked approval for a team-discovery tool.
- **Turn budget.** `walk-v1` reached the budget of 8 bot messages in four observations (seven alerts, and one relay cap). `owner-v1` reached it once, in a relay where the lead posted its answer twice and both specialists reported twice.

## Foundation suite, 4 pairs

`acceptance/m2-group-foundation.acceptance.test.ts`, the suite of the six-hour soak and of the delegation outcome campaign: a chief named by the human delegates to two experts, an unaddressed round, two peers mentioned at once, and a `message_bot` handoff. Its SOULs script every role, so it measures the routing, not the norm. Four pairs, 15:50:50 to 16:03:34 UTC.

| Case | Routing | Passed | Mean runs | Mean wall s | Mean input tokens | Mean output tokens | Mean cache read | Runs without usage |
|---|---|---|---|---|---|---|---|---|
| chief | walk-v1 | 4/4 | 7.3 | 22.0 | 19858 | 1556 | 142208 | 0 |
| chief | owner-v1 | 3/4 | 4.0 | 13.6 | 16066 | 770 | 90368 | 0 |
| ordered | walk-v1 | 4/4 | 3.0 | 11.0 | 9620 | 372 | 41088 | 0 |
| ordered | owner-v1 | 4/4 | 1.0 | 6.1 | 3561 | 243 | 13824 | 0 |
| parallel | walk-v1 | 4/4 | 4.0 | 10.4 | 9237 | 436 | 59136 | 0 |
| parallel | owner-v1 | 4/4 | 2.0 | 5.5 | 6013 | 282 | 28672 | 0 |
| direct | walk-v1 | 4/4 | 4.3 | 13.4 | 11929 | 795 | 82176 | 0 |
| direct | owner-v1 | 4/4 | 4.3 | 10.1 | 9831 | 539 | 84096 | 0 |

`walk-v1` 16/16, `owner-v1` 15/16. The runs that disappear are the ones the walk spent on members who had nothing to say: the two silent observers of the ordered round, the observers of each peer's reply in the parallel case, and the walk of the chief's final total.

The one failure, `owner-v1` chief, repetition 4, is the failure the soak retained: the chief's first run made one model call of 91 output tokens, called no tool, and ended with an empty reply and a `done` field saying it had "posted the single delegation message". Nothing was posted. It is the first thing the chief does, before any notice, offer or owner exists; what differs between the arms at that point is the system prompt, which under `owner-v1` carries the group norm. The soak saw this failure in about two of nine chief observations and the delegation outcome campaign in two of nine on its candidate arm and none of nine on its base arm, so one in four against none in four decides nothing either way. It stays open, and the human still sees nothing when it happens.

## Confirmation on the head, 2 pairs

One Gateway change came after campaign B: the notice no longer wakes a delegator its delegate already woke by mention (found by the T2 tier, above). The sidecar and the image are the same. Two pairs of each suite on that code:

| Suite | Routing | Answered or passed | Runs | Input tokens | Output tokens | Cache read tokens | Observations with an approval asked |
|---|---|---|---|---|---|---|---|
| group owner, 4 scenarios | walk-v1 | 8/8 | 69 | 260699 | 21635 | 2089472 | 2 |
| group owner, 4 scenarios | owner-v1 | 8/8 | 31 | 109742 | 7968 | 973824 | 0 |
| foundation, 4 cases | walk-v1 | 8/8 | 35 | 84878 | 6347 | 602624 | not counted |
| foundation, 4 cases | owner-v1 | 8/8 | 24 | 61386 | 4471 | 480768 | not counted |

Every run has a usage row. Under `owner-v1` the three unaddressed scenarios took exactly three runs each in both repetitions: the taker, the teammate it asked, and the taker again. In campaign B they took four, the fourth being the run the notice woke for nothing.

The relay took five runs once and eight once. In the eight-run repetition the lead, with both parts in, wrote "@g_prices @g_stock Thanks, both parts are in" before its answer. The norm says not to; the two mentions woke both specialists, both ended silent, and both silences were announced to the lead: four runs and two notices that the human sees, for a thank-you. Nothing looped, because the lead stayed silent.

## What this does not show

- Three scripted-role bots and four questions are one small case. Eight and sixteen observations per arm cannot rank two arms that both answer; they can show a difference of a factor of two in runs, and they did.
- The norm was revised once after the smoke, on the same case. A different model, or different roles, may need different words.
- Work handed on twice (a delegate that asks a third bot) is covered by deterministic tests only. No real-model observation took that path: the relay's lead asked both specialists itself.
- A hand-off written into the final reply instead of `thread_post` gets no feedback from decision 19. No dead end was observed in the 24 `owner-v1` observations after the fix; one was observed in nine before it. That is not evidence that the fix works, only that the failure is not common.
- A mention that only thanks or credits a teammate still costs runs and a visible notice. The norm reduces it and does not end it.
- Timed-out runs cannot be classified, because a campaign stack's ledger is deleted with the stack. A later campaign should keep the SQLite file.
- The browser, takeover and billing acceptance suites were not run under `owner-v1`.
- The web changes have unit tests and were not checked in a browser.

## Decisions for the owner

1. **Land the branch.** `git cherry-pick 6bfe51e..group-owner` on `main`; nothing is pushed or deployed. One of its fixes is for a regression that is on `main` now (the notice's second wake).
2. **The default.** By the rule written before campaign A, `owner-v1` is the default: it answered as often as `walk-v1` in campaign B and the confirmation (24/24 against 24/24), took 98 runs where the walk took 192, about half the tokens, and asked no approval where the walk asked in six observations of 24. The foundation suite passed 23/24 against 24/24, the miss being the retained first-turn failure. A deployment upgraded without setting `DESKMATES_GROUP_ROUTING` changes routing; `walk-v1` keeps the old behaviour and costs nothing to switch back to.
3. **Join order decides who is offered first.** If the coordinator should be the one that steps up, put it first in the thread, or address it once: the first single mention in a thread with no owner names the owner. A cheap-model bid to pick the first member by fit was deferred; nothing here shows it is needed yet.
4. **Not done, and worth doing next:** tell the human when a bot it addressed ends without a reply (the retained "chief ends silently" failure is still silent to the human); keep campaign ledgers; `thread_wait` is still not started and nothing here needed it.
