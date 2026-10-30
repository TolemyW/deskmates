# ADR-0029: An upgrade drains to a safe point, and a restart parks live runs for continuation

Date: 2026-10-12
Status: Accepted (owner-signed 2026-10-17, issue #3: "signed as written, including decision 11 (missed cron minutes are skipped, not back-filled)"; changes the outcome of a Gateway restart and amends ADR-0016 decision 2)
Source: found in the long-horizon campaign of 2026-10-11 (campaign instance upgraded v0.5.0 → v0.5.3 with an always-on team; operator measurements below), the autonomous team's restart proposals of the same day, the independent review of those proposals, and the external references gathered in issue #54. Builds on ADR-0002 (park and resume, short-lived run tokens, SDK state on the workspace volume), ADR-0005 (lanes, threads), ADR-0016 (continuation, delegation outcome notices) and ADR-0023 (models frozen per run).

## Context

The stable deployment is upgraded with `scripts/stable/stable.sh activate`. Its `drain` step polls `GET /api/runtime` until `activeRuns` is 0 (runs in `running` or `waiting_approval_live`), waits at most `DRAIN_TIMEOUT` (600 s), then refuses unless `FORCE=1`. On start the new Gateway calls `Scheduler.reconcile()`, which fails every run the ledger lists as live with the prose error "gateway restarted while the run was live" and revokes its token.

Measured by the operator on 2026-10-11, campaign instance, v0.5.0 → v0.5.3:

- The drain never finished. Nothing stops the scheduler from launching while the script polls, so with a team that is always working `activeRuns` never reached 0 in 600 s (10 runs active at the deadline).
- `FORCE=1` stopped the Gateway in 11 s. Reconcile then failed every live run: 3 runs in one workspace and 6 in another were killed with the prose error, mid-task. Nothing was resumed; senders got no reply and no explanation in their threads.
- Runs that end abnormally (timeout, restart) have no `run_usage` rows. Their tokens exist only in `model_requests`, so cost reports and per-run statistics show them as free.
- A parked threadless cron round blocks every later tick of the same entry: `findLiveByTriggerPrefix` counts every non-terminal status as live, by design, so the round is not asked twice. A round parked on a continuation ask therefore skips ticks for up to the 24-hour continuation window, and nobody is told.

The work of a killed run is mostly not lost. Its SDK session transcript is on the workspace volume (ADR-0002 decision 3), and `resume: sessionId` continues it, as approval and continuation resumes already do. What is missing is a way to stop at a point where resuming is safe, and a reconcile that resumes instead of failing.

The test strategy's fault checklist (§5) expects "Gateway restarts while a run is in progress: the run inside the sandbox continues; the Gateway backfills events after reconnecting". That row was never implemented, and this ADR replaces its expectation.

The autonomous team proposed, in its own fork, that a restart-failed run keep its token alive so a surviving sidecar can report later and reopen the run. The review of that proposal found that the premise (sidecars survive a Gateway restart) was never verified, and that a kept token lets a process the new Gateway knows nothing about spend outside every accounting boundary. Worth keeping from it: a stable `gateway_restarted` error code, a thread notice, and a bounded retry in the sidecar's event sink (issue #68 item 6).

External practice (issue #54, read 2026-10-11): Grok Bot pauses agents at a safe point, resumes them on the new computer, and refuses the update when it cannot pause. OpenClaw drains before restart, recovers interrupted sessions without replaying interrupted tool calls, caps recovery at three attempts and has a crash-loop breaker.

## Definitions

- **Drain.** A Gateway state in which the scheduler starts no sidecar process (no new run, no resume), while every trigger is still accepted and recorded.
- **Safe point.** The moment a run's `PreToolUse` hook runs for its next tool call. No tool call of the run is executing; the call about to run has not started.
- **Platform interruption.** A run stopped by the platform, not by its own work: a drain, a Gateway restart, or an operator force-stop during an upgrade. A sidecar crash, the wall-clock deadline and `error_max_budget_usd` are not platform interruptions.
- **Drain budget.** How long a drain waits for every active run to reach a safe point. Default 120 s, a guess; calibrated by decision 13's drain-time metric.

## Decision

1. **Drain stops launching and keeps accepting.** An authenticated operator route (`POST /api/runtime/drain`, and `DELETE` to end it) puts the Gateway in drain. In drain the scheduler starts no queued run and resumes no parked run. Human and bot messages, approval decisions, webhooks and cron ticks are accepted and recorded as usual; their runs are queued and start after the drain ends or on the next Gateway. `GET /api/runtime` reports `draining`, `activeRuns` and the runs parked by the drain. Drain is a property of the running process: a new Gateway starts out of drain.

2. **An active run parks at its next safe point.** When drain begins, each active run is told through the acknowledgement of its next event batch (the sidecar already posts batches continuously; no new poll per tool call). Its next `PreToolUse` hook returns `defer` with a platform-interruption payload `{interruption: "platform", reason: "drain"}` instead of its usual decision. A hook already blocked in a live approval wait ends the wait as `defer` the same way; the approval stays pending. The query ends and reports its session id, as for an approval defer. The run goes to a new parked status, `waiting_platform`: it releases its lane and the browser lock, its token is revoked, and it holds its `(bot, thread)` session as every parked run does (ADR-0002 amendment 2). The deferred call was never executed, and on resume the SDK replays it through the hook, which tiers it as usual. A run that ends on its own during the drain ends normally.

3. **When the budget is exceeded, the upgrade is retried, not forced.** If active runs remain after the drain budget (a long tool call or a long model turn has no safe point until it ends), the release script ends the drain, which resumes launching and the runs parked by the drain, and retries the upgrade automatically after a backoff (default 10 minutes, at most 3 attempts; both guesses). After the last attempt it stops and reports which runs never reached a safe point. `FORCE=1` remains an explicit operator override; a forced stop goes through decision 4 like any restart.

4. **Reconcile parks live runs for continuation instead of failing them.** On start, every run the ledger lists as live has no process this Gateway started. Reconcile first makes sure no old process can act for it: the run's tokens are revoked, and the sidecar process of that run is killed in its workspace (the sandbox provider kills by run marker; the old process may have survived the Gateway). Then:
   - a run with a recorded SDK session id goes to `waiting_platform` with reason `restart`, and is resumed as a new attempt with `resume: sessionId` on the first scheduling pass;
   - a run with no session id never reached the SDK and is requeued as a new attempt;
   - parked runs are left as they are, as today.

   **This amends ADR-0016 decision 2.** That decision says "other failures (`error_max_budget_usd`, the wall-clock deadline, crashes) are unchanged and still end `failed`". A platform interruption is not a crash of the run: it now parks as `waiting_platform` and continues automatically, without asking the delegator, within decision 6's caps. Sidecar crashes, the deadline and the budget cap still end `failed`. ADR-0016's continuation (`waiting_continuation`, a human or delegator decides) is unchanged.

5. **An interrupted tool call is handled by its tier, and an L2 call is never replayed automatically.** A drained run has no interrupted call (decision 2). A run killed by a restart may have one: a `tool_call` ledger event with no `tool_result`. The `tool_call` event records the tier the hook assigned. The resumed attempt's first turn carries a harness notice, not page content, naming the interrupted call and what to do:
   - **L0**: the call was read-only and its result was lost; repeat it if it is still needed.
   - **L1**: the outcome is unknown; the write may or may not have happened. Check the state before repeating it.
   - **L2**: the outcome is unknown; the platform will not repeat it. The approval that allowed it is spent. In that attempt, the hook asks a human again for any L2 call with the same stable dimensions `(toolName, targetOrigin, argumentPattern)`, even when an Always rule matches, and the request says the earlier attempt was interrupted with an unknown outcome.

   No interrupted call of any tier is re-executed by the platform.

6. **Recovery is capped, and a crash loop stops it.** A run may be continued after a platform interruption at most 3 times (`runs.platform_resumes`, recorded in `runs.config_json`). The fourth interruption ends it `failed` with `gateway_restarted`. If the Gateway starts more than 3 times within 10 minutes (counted in the database), reconcile parks live runs as in decision 4 but resumes none of them; the operator UI shows the breaker and lists the parked runs, and resuming them is an operator action. Both limits are guesses, calibrated on decision 13's metrics.

7. **A run that a platform interruption ends says so.** The error is the stable code `gateway_restarted` in `contracts` (the issue #21 mechanism: the UI and exports render it, never prose). A run that ends with it posts one `system` notice in its thread naming the bot and that a platform restart stopped the run and it could not be continued; the ADR-0016 amendment 1 delegation notice follows as for any `failed` run. Parking and an automatic continuation post no thread message; the run's status shows `waiting_platform` in the UI. The notice is routing-inert: it wakes no bot except the delegator ADR-0016 amendment 1 names.

8. **An abnormally ended attempt still has its usage.** When an attempt ends without the sidecar reporting usage (killed by a restart, the deadline, a crash, a forced stop), the Gateway writes that attempt's `run_usage` rows from the `model_requests` its token made, marked `source = proxy`. A request whose usage the upstream did not report makes the attempt's usage incomplete (`usage_complete = false`), counted as unknown, never as zero. The next attempt on the same session cannot use the SDK's cumulative total as a baseline, because the previous total was never reported; its usage also comes from `model_requests`, marked the same way.

9. **A resumed attempt gets a new token; the old token is revoked.** Decision 4 revokes before it resumes, and ADR-0002's definition of a short-lived token (one per sidecar process, revoked at a terminal or parked state) holds for platform interruptions too. The campaign team's alternative, keeping a restart-failed run's token alive so a surviving sidecar can report later and reopen the run, is rejected:
   - the model proxy authorises by token only, so a surviving process would spend for up to the token TTL (4 h) outside capacity, the run deadline, the lane and the drain;
   - the new Gateway may resume or relaunch the same `(bot, thread)` SDK session while the old process still writes it, which ADR-0002 decision 3 and amendment 2 forbid;
   - reconcile releases the browser lock, so a surviving process would drive the shared browser without holding it;
   - reopening a terminal run bypasses the run state machine, and the late-report window (about 15 s of retry) is shorter than any real upgrade.

   Killing the old process and resuming its session gets the same work back without any of these.

10. **A resume across an SDK version change is a release gate, with a fallback.** A run records the SDK version it started on. A release that changes the pinned Agent SDK version must pass a resume-compatibility test: a session parked by the old image resumes on the new image and its first request carries the old transcript. If the gate cannot pass, or a resume fails at start because the session cannot be read, the run continues as a new attempt on a **fresh session** with a Gateway-composed handoff: the thread slice it was delivered, the path of its latest handoff file if any (ADR-0016), and a ledger summary of the tool calls it made with their tiers and decision 5's interrupted call. The handoff is harness text; any bot or page text in it stays wrapped. Release notes state when parked runs will resume fresh.

11. **Cron misfires are skipped by default.** A tick whose minute passed while the Gateway was stopped is not fired later; the next start records one `log` event per entry naming the skipped minutes. A cron run queued during a drain whose minute is older than `CRON_MISFIRE_GRACE` (default 5 minutes, a guess) when it could launch is cancelled as a misfire. A per-entry `misfire: "run_once"` fires one catch-up round on start instead, never more than one.

12. **A parked threadless round does not block later ticks silently.** A previous round that is still live (including parked) still skips the next tick, as today, so nobody is asked twice. The first skip caused by a parked round, and then at most one per hour, is a notice in the bot's private chat and the operator UI naming the parked round and its pending request (ADR-0002 amendment 3 covers threadless approval notices). A round parked by a platform interruption resumes automatically and needs no notice.

13. **The long-horizon campaign measures it.** Each long-horizon campaign that crosses an upgrade or restart reports, from the ledger: runs killed by a platform interruption (target 0 for a drained upgrade); runs continued after an interruption and the share of them that later succeed; duplicate L2 effects (target 0: an L2 action executed twice for one approval); time from drain start to the last active run reaching its safe point (p50, max); upgrade attempts per release.

## Alternatives considered

- **Keep failing live runs at restart.** The status quo: cheapest, and it loses mid-task work and replies, as measured.
- **Wait for runs to finish on their own.** The current drain. Even with launching stopped, a run can take up to its deadline, and an always-on team always has one.
- **Force after the timeout by default.** Kills runs that would have reached a safe point a minute later. Kept as an explicit override only.
- **Keep the token alive and accept a late report** (the campaign team's proposal). Rejected for decision 9's reasons.
- **Let sidecars survive and reattach to the new Gateway**, as the test strategy row expected. Needs a reconnect protocol, lane and lock accounting for processes the new Gateway did not start, and runs old sidecar code after an SDK change. Not now; decision 4's kill-and-resume covers the same work.
- **Park at a turn boundary instead of a tool call.** The SDK offers no verified parking point other than `PreToolUse` `defer`.
- **Replay interrupted L1 and L2 calls automatically.** Duplicates writes and external side effects. Rejected.
- **Catch up every missed cron tick.** A burst of stale rounds after any downtime. Available only as one round, by choice.

## Verification

| Item | Means | Test | Metric |
|---|---|---|---|
| 1 | In drain no queued run starts and no parked run resumes; a human message, an approval decision, a webhook and a cron tick during drain each produce their row and their queued run; ending the drain starts them; `/api/runtime` reports `draining`; the drain route is operator-authenticated and refused with a run token | T1 `scheduler/drain.test.ts` with the in-process harness (`test-support/harness.ts`) and the fake provider; T1 `operator-auth.test.ts` row for the route | none |
| 2 | With drain on, a scripted sidecar's next `PreToolUse` returns `defer` with the platform payload; the run ends `waiting_platform` with its session id, lane and lock released, token revoked; the deferred call never executed; a live approval wait ends as `defer` with the approval still pending; after the drain ends, the resumed attempt replays the call through the hook exactly once | T1 sidecar `run-once.test.ts` with the fake SDK; T1 `scheduler/drain.test.ts`; T2 `acceptance/m4-upgrade-drain.container.test.ts` (real SDK `defer` for a non-L2 tool, resume on the same session) | drain time to safe point (p50, max) |
| 3 | With a scripted tool call longer than the budget, the drain ends unforced, launching resumes, and the script retries after the backoff up to 3 times, then exits non-zero naming the runs; `FORCE=1` still stops | T0 `scripts/stable/stable.test.mjs` with a fake runtime endpoint; T1 drain end resumes the parked runs | upgrade attempts per release |
| 4 | After a restart on a file database, a live run with a session goes to `waiting_platform` and is resumed once as attempt n+1 with `resume: sessionId`; one with no session is requeued; parked runs are untouched; the provider's kill is called for every live run before any resume; ADR-0016's sidecar-crash, deadline and budget failures still end `failed` | T1 `scheduler/restart-recovery.test.ts` (harness, file database, fake provider records kills); T2 fault test `acceptance/m4-restart-recovery.container.test.ts`: the Gateway process is killed while a sidecar is live in a real workspace, a new Gateway starts on the same database, the old sidecar is gone, the run resumes on its SDK session and succeeds | killed runs per restart; recovered-to-success rate |
| 5 | A restart during a scripted tool call of each tier yields a resumed first turn carrying the tier's notice; no call is re-executed by the platform; after an interrupted L2, a matching Always rule does not answer the same-dimension call in that attempt and a human request is posted that names the interruption | T1 `scheduler/restart-recovery.test.ts`; T1 sidecar hook test for the post-interruption L2 rule bypass; T2 restart fault test with an interrupted L2 call | duplicate L2 effects (target 0) |
| 6 | A fourth platform interruption ends the run `failed` with `gateway_restarted`; four starts within 10 minutes (fake clock) park live runs and resume none until an operator resumes them | T1 `scheduler/restart-recovery.test.ts` | breaker trips per month |
| 7 | `gateway_restarted` is a `contracts` error code with a rendered sentence; a run ending with it posts exactly one routing-inert `system` notice and the ADR-0016 delegation notice; parking and automatic continuation post no message | T0 contracts error-code list; T1 `threads/delegation-outcomes.test.ts` case; T1 restart-recovery thread assertions | none |
| 8 | An attempt killed after two proxied requests has `run_usage` equal to their token sums with `source = proxy`; a request with missing usage sets `usage_complete = false`; the next attempt on that session is also proxy-sourced; totals are never double counted | T1 `ledger/usage.test.ts` and `model-proxy` usage cases | share of attempts with proxy-sourced or incomplete usage |
| 9 | After reconcile, the old token fails the model proxy and every `/internal/runs/:id/*` route; the resumed attempt has a different token that works | T1 `scheduler/restart-recovery.test.ts`; T2 restart fault test (old sidecar's token rejected if it survived) | none |
| 10 | The run's `config_json` records its SDK version; the release checklist runs the resume-compatibility test when the pinned SDK changes; a resume that fails on an unreadable session continues on a fresh session whose first turn carries the handoff with wrapped bot text | T2 `acceptance/sdk-resume-compat.container.test.ts` (old image parks, new image resumes); T1 fallback with the fake SDK failing resume | fresh-session fallbacks per release |
| 11 | With a fake clock, a Gateway stopped across three ticks fires none of them on start and logs the skipped minutes; a queued cron run older than the grace is cancelled as a misfire; `run_once` fires exactly one | T1 `triggers/cron.test.ts` | misfire skips per day |
| 12 | A cron round parked on a continuation ask skips the next tick and posts one notice to the private chat and operator UI, then at most one per hour; a `waiting_platform` round posts none | T1 `triggers/cron.test.ts` | cron ticks skipped behind a parked round |
| 13 | The campaign report lists the five measures from the ledger alone | `evals/` campaign report script (to be written with the implementation); next long-horizon campaign that crosses an upgrade | killed runs; recovered-to-success rate; duplicate L2 effects = 0; drain time to safe point; upgrade attempts |

## Consequences

- `contracts` gains the `waiting_platform` status (parked, not terminal), the platform-interruption payload of `run_ended(deferred)`, the `gateway_restarted` error code and `RuntimeStatus.draining`. A forward-only migration adds `runs.platform_resumes`, `run_usage.source`, `run_usage.usage_complete` and a Gateway start log for the breaker.
- `SandboxProvider` gains a kill of one run's sidecar process.
- `scripts/stable/stable.sh activate` calls the drain route, retries as in decision 3, and keeps `FORCE=1`.
- The test strategy §5 row "Gateway restarts while a run is in progress" is reworded to decision 4 when this ADR is accepted.
- On acceptance ADR-0016 gets a pointer under decision 2 to decision 4 here.
- An upgrade that drains cleanly costs each active run one extra resume: one more process start and the cached prefix of its session.
- Decision 2 relies on `PreToolUse` `defer` for any tool, not only L2 calls. S0 verified `defer` for an L2 call; the T2 test of row 2 verifies the general case before implementation is called done.

## Implementation clarification — descendant cleanup (2026-10-26)

The owner requested complete cleanup of cancelled runs, including detached children
that clear their environment. The marker scan in decision 4 identifies a run's
supervisor, but cannot identify every descendant. Each `deskmates-sidecar run`
therefore starts beneath a Linux child subreaper. The subreaper owns only process
lifetime: it forwards stdin/stdout/stderr unchanged, adopts orphan descendants,
and kills and reaps its children on termination or when the sidecar exits. It is
not a tool interceptor, a new agent loop, or a per-bot security boundary. All runs
retain the workspace's user, filesystem, network and shared Chromium.

The provider first requests termination of matching subreapers and waits for their
exit before legacy marker cleanup. A failed cleanup is reported rather than
silently treated as a confirmed kill. Images without the helper keep legacy,
best-effort cleanup; a new image is required for the stronger lifecycle guarantee.
An uninterruptible kernel task, container failure or deliberate same-user killing
of the supervisor cannot be reported as confirmed cleanup. No fallback stops the
workspace or another run. Run token revocation remains independent.

| Item | Means | Test | Metric |
|---|---|---|---|
| decision 4, descendant cleanup | Environment-free, setsid, double-fork and signal-resistant descendants are reaped before cancellation returns; unrelated run and workspace processes survive; timeout/abort and restart-by-run-id use the same cleanup | T2 `run-supervisor.container.test.ts`; T0 `docker-provider.test.ts` command/cleanup error coverage | cleanup failures, reported separately from token revocation |
| decision 4, normal exit and compatibility | Sidecar exit status and stdin/output survive supervision; descendants do not outlive a completed sidecar; legacy images remain explicitly best effort | T2 `run-supervisor.container.test.ts`; T0 image wiring coverage | orphan descendants after a confirmed cleanup = 0 |

Linux's [child-subreaper contract](https://www.man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html)
keeps double-forked descendants parented to a living ancestor subreaper. Process
identity for signaling uses Linux pidfds, as exposed by Python's
[`pidfd_open`](https://docs.python.org/3/library/os.html#os.pidfd_open) and
[`pidfd_send_signal`](https://docs.python.org/3/library/signal.html#signal.pidfd_send_signal),
so a recycled numeric PID is never the target of a stale cleanup request.
