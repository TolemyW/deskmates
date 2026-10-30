# Run startup timeline and reply preview (ADR-0037)

## Timeline marks

Each run attempt records `log` events with `source: "run_timeline"`, `version: 1`, a `mark` and
`at` (wall time in the recording process). The Gateway records `attempt_started` (`start`,
`session`, `trigger`, `readyAt` on a resume), `sandbox_ready` (`sandbox`: `created`, `attached`
or `cached`; `sandboxRetried`), `sidecar_spawned`, `run_ended` (`outcome`, `replyPosted`),
`reply_preview_published` and `attempt_closed` (`spawned`, `exitCode`, `timedOut`, `error`).
`run_ended.outcome` is the sidecar-reported outcome, while `run_ended.runStatus` is the
Gateway status after committing result validation and delivery. A model job can report
`outcome: "completed"` but have `runStatus: "failed"` when it returns no usable result;
`attempt_closed.exitCode: 0` only describes its process exit. None of these observations
changes approval decisions or retries. Older receipts without `runStatus` leave that
observation unknown; use the run row for its current status.

The sidecar records `sidecar_started` (`processStartedAt`), `query_started`, `sdk_init` (MCP
server statuses), `first_stream_event`, `first_token`, `first_text` and `sdk_result` (SDK-reported
numbers, verbatim). The first upstream request and byte come from the model proxy's
`phase_timing` spans. A recorder failure never changes the run.

`GET /api/runs/:id/timeline` (Member, like `/context`) returns `buildRunTimeline` from
`@deskmates/contracts` over the run's whole ledger: every stage of every attempt in a fixed order,
`observed: false` and null durations for a stage without a mark, the longest wait, and, for an
open attempt, the stage it is waiting for. The run detail shows it under "Startup timeline".

`npm run latency-report -- --db <gateway.sqlite>` reports percentiles per attempt class from an
exported database, opened read-only (`evals/README.md`).

Gateway and sidecar clocks are different processes; under a VM-backed Docker they may differ.

## Reply preview

`POST /internal/runs/:runId/reply-preview` takes `{type: "reply_preview", runId, attempt, seq,
text}` with the run token. Only the live process of the run's current attempt is relayed; a
frame not above the last `seq` of its attempt is dropped. The Gateway publishes
`run_reply_preview` scoped to the run (Guests do not receive it) and writes no ledger row or
message; the final reply message remains the record. The sidecar sends only the decoded `reply`
string of the summary block, redacted, as cumulative snapshots.
