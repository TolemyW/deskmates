# Upgrade drain and restart recovery (ADR-0029)

Accepted by the owner on 2026-10-17 (issue #3). An upgrade drains the Gateway to a safe point, and
a Gateway start parks the runs the ledger lists as live for continuation instead of failing them.
The release script side is in [the stable release runbook](../../../docs/runbooks/stable-release.md#upgrading).

## The drain (decisions 1 to 3)

`POST /api/runtime/drain` puts this process in drain; `DELETE /api/runtime/drain` ends it. Both are
platform operator routes (`api/route-policies/installation.ts`) and answer with the
`RuntimeStatus` that `GET /api/runtime` reports: `activeRuns`, `activeRunIds`, `draining`,
`drainStartedAt`, `drainParkedRunIds` and `restartBreaker`. A drain is a property of the running
process; a new Gateway starts out of drain.

In drain `Scheduler.tick` still sweeps expiries and deadlines and continues routing walks, but
launches nothing: no queued run, no resume, no review or triage job. Every trigger is still accepted
and recorded; a cron round created during a drain carries `queuedInDrain: true`.

A live run hears of the drain through the acknowledgement of its next event batch
(`POST /internal/runs/:runId/events` answers `{stored, drain: true}`, `SidecarEventsAck`). The
sidecar's next `PreToolUse` hook returns `defer` before the call starts, whatever its tier, and the
run ends `run_ended(deferred)` with `platformInterruption: {interruption: "platform", reason:
"drain"}`. A hook blocked in a live approval wait gets a `defer` with `platform: "drain"` from its
next poll of `GET /internal/runs/:runId/approvals/:approvalId`; the approval stays pending. A call
that carries a human's decision (the replay of an approved call, or a decision waiting for its
retry) is let through so the decision is not lost; the next call parks.

The lifecycle parks such a run as `waiting_platform` with `resumePayload.platform = "drain"`: it
holds no lane, its token and browser lock are released, and it keeps its `(bot, thread)` session.
Ending the drain resumes it as attempt n+1 on the same session with the trigger
`{kind: "platform_resume", reason: "drain"}`; the SDK replays the deferred call through the hook,
which tiers it as usual. A drained run whose approval is still undecided when the drain ends moves
to `waiting_approval` and resumes on the decision like any approval park.

## Restart recovery (decisions 4, 5, 6, 9)

`Scheduler.reconcile` (awaited in `onReady`) records the start in `gateway_starts`, then for every
run in `running`, `stalled` or `waiting_approval_live`:

1. revokes all of the run's tokens, so a surviving sidecar can reach neither the Gateway nor the
   model proxy;
2. kills the run's old sidecar in its workspace: the scheduler sets `DESKMATES_RUN_ID=<runId>`
   (`RUN_MARKER_ENV`) on every sidecar exec, and `SandboxProvider.killRun` kills each process whose
   environment carries it. Every live run is killed before any run resumes;
3. hands the run to `RunLifecycle.parkAfterRestart`:
   - its attempt's usage is filled in from its requests (decision 8, below);
   - with a recorded session (`POST /internal/runs/:runId/session`, which the sidecar sends at SDK
     init and which stays off the ledger), it parks as `waiting_platform`, reason `restart`, and is
     resumed as attempt n+1 with `resume: sessionId` on the first scheduling pass;
   - without one it never reached the SDK and is requeued as attempt n+1;
   - a live approval wait whose approval is still pending was never executed: the run waits on that
     approval;
   - a fourth platform interruption ends it `failed` with `gateway_restarted`.

Decision 5: the call of the attempt whose `tool_call` has no `tool_result` is the interrupted call.
Its tier is the hook's: an approval row for the call makes it L2. The resumed attempt's trigger
carries it as `interruptedCall`, and the sidecar's harness notice says what to do: repeat an L0 call
if needed, check the state before repeating an L1 call, and do not assume an L2 call did or did not
happen. Nothing is re-executed by the platform. For an interrupted L2 call the run records
`platformL2Recheck` for the resumed attempt; the broker (`repeatsInterruptedL2`) then sends a
request with the same `(toolName, targetOrigin, argumentPattern)` to a human, past every stored rule,
the approval mode and the reviewer, and the card says the earlier attempt was interrupted with an
unknown outcome. The sidecar flags such a request `afterInterruption`; the Gateway decides by its own
record.

Decision 6: `runs.config_json.platformResumes` (also the generated column `runs.platform_resumes`)
counts continuations after a platform interruption, at most `PLATFORM_RESUME_LIMIT` (3). More than
three starts within ten minutes (`gateway_starts`) trip the restart breaker: live runs park as above
with `platformHeld: true` and none resumes. `GET /api/runtime` shows `restartBreaker.tripped` and
`heldRunIds`; `POST /api/runtime/platform-resume` (`{runIds?}`) releases them, and the run drawer
shows the hold with a button for it.

## What a run that cannot continue says (decision 7)

`gateway_restarted` (`RUN_ERROR_GATEWAY_RESTARTED` in contracts, failure class
`platform_interruption`) is rendered as a sentence by the UI. A run that ends with it posts one
routing-inert `system` notice in its thread (a threadless run's in its bot's private chat), then the
ADR-0016 amendment 1 delegation notice, which wakes the delegator only. Parking and an automatic
continuation post nothing.

## Usage of an abnormally ended attempt (decision 8)

When an attempt's process is gone without the sidecar's usage (a restart, the deadline, a crash, a
cancellation), `RunLifecycle.fillProxyUsage` writes the attempt's `run_usage` from the
`model_requests` its token made: one row per served model, `source = 'proxy'`. A request the
upstream reported no usage for makes the row `usage_complete = 0`, a lower bound that the receipts
read as partial, never zero. The next attempt on the same session cannot subtract an SDK total that
was never reported, so its rows come from its requests too, while `session_usage` still moves to the
reported total so the run after it is measured from the SDK again. An SDK final for the same attempt
(a `run_ended` recovered from stdout) replaces a proxy row.

## Resume across an SDK change (decision 10)

The run records the CLI build the SDK reported at init on its first attempt as `config.sdkVersion`;
a later attempt on another build logs `{source: "platform", op: "sdk_version_changed"}`. When a
platform resume fails before the SDK starts a session (`RunEnded.resumeFailed`), the run parks again
with `platformFreshSession` and the next attempt starts a fresh session whose trigger carries a
Gateway-composed handoff: the delivered thread slice (bot and human text wrapped as untrusted), the
latest handoff file, and the earlier attempts' tool calls with their tiers. A release that changes
the pinned SDK runs `acceptance/sdk-resume-compat.container.test.ts`.

## Cron across a stop (decisions 11 and 12)

`CronRunner.catchUp`, called once after `reconcile`, finds every minute in `(previous Gateway last
alive, now)` each entry matched, and logs them once per entry; none fires. An entry with
`misfire: "run_once"` fires one round for the latest of them. `gateway_starts.last_seen_at` is
refreshed by the scheduler at most every 30 s. A cron round queued during a drain that can launch
only after its minute is older than `CRON_MISFIRE_GRACE` minutes (default 5,
`config/runs.ts`) is cancelled with `cron_misfire`.

A round still live (including parked) still skips the next tick. When the parked round waits for a
human (an approval, a continuation, the browser), the first skip and then at most one per hour post a
notice in the bot's private chat naming the parked run and its pending request
(`triggers/parked-cron-notices.ts`) and log `{source: "cron", op: "parked_skip_notice"}` on the run.
A `waiting_platform` round resumes by itself and posts none.

## Tests

- `scheduler/drain.test.ts`: rows 1 to 3 on the Gateway side.
- `scheduler/restart-recovery.test.ts`: rows 4, 5, 6, 9 and 10 on a file database.
- `ledger/usage.test.ts`, `model-proxy/proxy-sourced-usage.test.ts`: row 8.
- `triggers/cron.test.ts`: rows 11 and 12.
- `threads/delegation-outcomes.test.ts`, `api/operator-auth.test.ts`, `api/runtime-routes.test.ts`.
- Sidecar: `run-once.test.ts` (drain defer, live-wait defer, interrupted-call notices, the
  `afterInterruption` flag, resume failure and the fresh session), `ledger.test.ts`.
- `scripts/stable/stable.test.mjs`: the drain, retry, give-up and `FORCE=1` paths.
- T2, skipped without Docker: `acceptance/m4-upgrade-drain.container.test.ts`,
  `acceptance/m4-restart-recovery.container.test.ts`, `acceptance/sdk-resume-compat.container.test.ts`.
- Decision 13: `evals/platform-interruption-report.ts` reads the five campaign measures from a
  ledger database.
