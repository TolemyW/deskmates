# Run liveness: stall detection and live progress data (issue #9)

## The `stalled` status

A `running` run that has produced no progress event for `RUN_STALL_SECONDS` (default 300; 0
turns detection off) is marked `stalled`. Its next progress event, or any other call its sidecar
makes on `/internal/runs/:runId/*` (a lock, a message, its `run_ended`), returns it to `running`.

- Progress is any ledger event except the sidecar's 10 s `resource_observation` log and the
  Gateway's own `stall` log. The heartbeat proves only that the process is alive, so a run
  waiting on a model that never sends a byte still stalls. The model proxy's `phase_timing`
  spans are progress, so a request that is answered revives the run.
- A stall is an observation, never a decision. Nothing is killed or released: the run keeps its
  lane, run token and browser lock, `stalled` is in no terminal set, and a stalled run may end,
  park or be cancelled exactly like a running one. `RUN_TIMEOUT_SECONDS` stays the only kill.
- Only `running` stalls. A live approval wait (`waiting_approval_live`) and the parked statuses
  are waits with their own clocks; a run coming back from one starts a fresh quiet clock.
- Each change is a `log` event `{source: "stall", op: "stalled" | "resumed", idleMs,
  stallSeconds}` (`RunStallLogPayload` in `@deskmates/contracts`) and a `run_status` frame, so the
  chat row, the run list and the run screen show it without polling.
- The quiet clock is the Gateway's, kept in memory by the scheduler (`scheduler/run-stall.ts`),
  which sweeps every 5 s. A Gateway restart fails every live run, stalled ones included
  (`Scheduler.reconcile`), so nothing it forgets is still running.

`runs.status` admits `stalled` from migration `202610151800-run-stalled-status.sql`, which
rebuilds `runs` with the same columns, keys, indexes and triggers.

## Context window and screenshots

- The sidecar's `sdk` init log carries `maxContextTokens` when the CLI receives
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, so a live run has the window before it ends.
  `GET /api/runs/:id/context` returns it as `maxContextTokens`, from the latest init log or else
  the `RunEnded` value stamped on the run; null when the CLI got none, which is the default.
- `GET /api/runs/:id/screenshot` (Member, like `/events`) returns `{screenshot: RunEvent | null}`,
  the run's newest `screenshot` event, for the approval card's thumbnail.
- The sidecar pairs a page-changing action with its capture beside its SDK message loop: the
  wait for the capture file (up to 2 s) no longer delays the messages after it. Captures are
  settled before the run ends, so the capture directory is never removed under one.

What the operator UI derives from these events is in the web package's
[run progress](../../web/docs/run-progress.md) page.
