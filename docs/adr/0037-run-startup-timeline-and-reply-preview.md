# ADR-0037: Run startup timeline and streamed reply preview

Date: 2026-10-14
Status: Proposed (issue #108 stages 1 and 2; the owner has not yet confirmed the measurement and text-delta slice or its evidence gates). No live model or Docker measurement was run; persistent sidecar/query hosts (stage 4) and caching (stage 3) are out of scope.

## Context

The operator's 2026-10-13 review found that even a short "hi" waits noticeably, and `model_retry` events do not say where the time went. At base `26d0c1cc` (v0.6.7) every run attempt is a new sidecar process (`scheduler.ts` `execute` → `provider.exec(SIDECAR_RUN_CMD)`), every process calls the SDK's `query()` once, which spawns its CLI subprocess and MCP servers, and SDK `resume` restores a persisted transcript, not a living process. The workspace container is reused through `SandboxRegistry`'s cached handle. The model proxy already records `phase_timing` transport spans (`model_request`, `model_headers`, `model_first_byte`, `model_body`), and the sidecar already asks the SDK for partial messages (`includePartialMessages: true`) but reads only their usage. Nothing records when a run left the queue, when its container and process were ready, when the SDK finished initializing, when the first token or text arrived, or when a human could first read anything. Without those marks, "the container is slow" and "the model is slow" cannot be told apart, and any optimization would be guessed.

What the pinned SDK 0.3.278 offers, read from its `sdk.d.ts` (not exercised against a live model): with `includePartialMessages`, `SDKPartialAssistantMessage` (`type: "stream_event"`) carries one Messages API stream event (`message_start`, `content_block_start`, `content_block_delta` with `text_delta`, `thinking_delta` or `input_json_delta`, `content_block_stop`, `message_delta`, `message_stop`) and an optional `ttft_ms`, and the complete assistant message still follows; subagent frames carry `parent_tool_use_id`. `system/init` lists `mcp_servers` with a status. The success result carries undocumented `ttft_ms`, `ttft_stream_ms` and `time_to_request_ms`. There is no separate text-stream contract in the SDK or in Deskmates before this ADR.

The visible reply is not the model's raw text. The model ends its run with a fenced JSON summary whose `reply` field is the only text the Gateway publishes (`sidecar/src/summary.ts`), and `reply` is the last key the instruction lists. Streaming raw text deltas would show the JSON block and private `done` notes.

## Decision

1. **Timeline marks are ledger `log` events with `source: "run_timeline"`.** Each mark is one event of the attempt it belongs to, with payload `{source: "run_timeline", version: 1, mark, at}` plus mark attributes. No new event kind and no migration. `at` is the wall-clock instant the owning process observed. The marks and their owners are fixed:
   - Gateway: `attempt_started` (the scheduler took the run off its queue or parked state; `start: fresh | resume`, `session: new | resumed`, `trigger`, `readyAt` when the attempt became runnable), `sandbox_ready` (`sandbox: cached | attached | created`, `sandboxRetried`), `sidecar_spawned` (exec issued), `run_ended` (the sidecar's `RunEnded` was accepted; `outcome`, `replyPosted`), `reply_preview_published` (first preview frame of the attempt, decision 7) and `attempt_closed` (the attempt's process exited or never started; `spawned`, `exitCode`, `timedOut`, `error`).
   - Sidecar: `sidecar_started` (`processStartedAt` from the process's own uptime), `query_started` (context assembled, `query()` called), `sdk_init` (the SDK's `system/init` message; MCP server names and statuses), `first_stream_event`, `first_token` (first content delta of any kind), `first_text` (first text delta) and `sdk_result` (SDK-reported `num_turns`, `duration_api_ms` and, when present, the undocumented `ttft_ms`, `ttft_stream_ms`, `time_to_request_ms`, recorded verbatim and labelled SDK-reported). Only top-level messages count; subagent (`parent_tool_use_id`) streams do not.
   - Derived, not recorded again: `submitted` (the triggering message's time for a thread run, else the run's creation), `routed` (run creation), `first_upstream_request` and `first_upstream_byte` (the attempt's earliest `phase_timing` `model_request` start and `model_first_byte` ok end of an inference request), `first_visible_text` and `terminal` (run row `finishedAt`).

2. **Missing means not observed, never zero.** The derived timeline lists every stage for every attempt in a fixed order with `observed: false` and `at: null` when its mark is absent. A duration is `null` unless both ends were observed. Nothing is interpolated from neighbours, and a stage seen out of order is reported as observed with its real time, not reordered.

3. **Attempts are classified, not averaged together.** Each attempt carries `start` (`fresh` for attempt 1, `resume` for a parked run's later process), `session` (`new` SDK session or `resumed` thread session), `sandbox` warmth (`created`: cold container; `attached`: an existing container this Gateway process had not cached; `cached`: warm) and its `model_retry` count. Reports group by these classes; a retried attempt is reported separately from one without retries.

4. **Clocks.** Within one process a mark's `at` is that process's wall clock. Gateway and sidecar clocks are different processes and may differ under a VM-backed Docker (Colima); cross-process durations are reported as measured and the report states the caveat. Existing `phase_timing` spans keep their monotonic durations.

5. **Derived on read, shown in the run detail.** `buildRunTimeline` in `contracts` derives the per-attempt timeline from the run's ledger and row. `GET /api/runs/:id/timeline` (operator route, Member, same policy as `GET /api/runs/:id/context`) returns it computed from the whole ledger, never a page of it. The run detail shows a compact per-attempt timeline in `features/runs/`.

6. **An offline report, not an experiment.** `npm run latency-report -- --db <gateway.sqlite>` opens a database export read-only and reports, per class, p50 and p95 of end-to-end, time to first upstream request, time to first token, time to first text and time to first visible text, plus failure, retry and first-turn cache-read distributions, with the count of attempts that did not observe each stage. A faster first response is not quality evidence; a comparison uses equivalent configurations under the measurement protocol. Live model or Docker measurement needs separately approved scope and budget.

7. **Streamed reply preview (stage 2).** The sidecar decodes, from top-level text deltas, the `reply` string of the summary JSON block as it is generated (an incremental JSON string decoder; nothing outside that string is sent), redacts it with the run's secrets, and posts throttled cumulative snapshots `{attempt, messageId, seq, text}` to `POST /internal/runs/:runId/reply-preview` with the run token. The Gateway keeps no ledger row per frame; it publishes a `run_reply_preview` SSE event scoped to the run (same audience as `run_status`, so Guests do not receive it) and records `reply_preview_published` once per attempt. The final reply message remains authoritative: the chat shows one provisional bubble per run, replaces it with the final message, and drops it when the run ends, parks or is cancelled. Snapshots are cumulative and carry `seq`, so a duplicate or reordered frame is ignored and a reconnect resumes from the next frame. Previews never change routing, transcript, approvals or usage.

8. **No new retry owner and no behaviour change.** Marks and previews are observations: a recorder or preview post failure never fails a run, the Gateway and proxy add no model retries (ADR-0023 decision 3 stands), and no prompt, SOUL or summary-key order changes. Moving `reply` earlier in the summary block would make the preview start sooner, but it is a strategy change that needs a paired evaluation first.

## Alternatives considered

- **A new run event kind for marks.** Rejected: it needs a `run_events.kind` table rebuild for no reader benefit; `phase_timing` already uses `log` with a source.
- **Storing a computed timeline on the run row.** Rejected: the ledger is the record and derivation can improve without migrating rows.
- **Streaming raw assistant text.** Rejected: it would publish the summary JSON and private `done` notes that the summary contract keeps out of the thread.
- **Delta frames with offsets.** Rejected for previews: cumulative snapshots are idempotent across duplicates and reconnects, and replies are small.
- **A persistent sidecar or query pool now.** Out of scope until measurement shows where time goes and a reviewed ADR covers SDK lifecycle, token rotation, approval resume, recovery, memory and locks (issue #108 stage 4).

## Consequences

- Every attempt adds about a dozen small ledger events.
- The run detail can say which phase a slow start waited in, and the report can compare cold and warm, fresh and resumed, retried and unretried attempts from an exported database.
- The chat can show reply text before the run ends, but only once the model reaches the `reply` key; thread_post bodies are not previewed.
- Cross-process durations inherit clock skew between host and container.

## Verification

| Decision | Concrete meaning | Test | Metric |
| --- | --- | --- | --- |
| 1 | Gateway marks attempt_started, sandbox_ready, sidecar_spawned, run_ended, attempt_closed with their attributes; sidecar marks sidecar_started, query_started, sdk_init, first_stream_event, first_token, first_text, sdk_result from fake SDK messages, top-level only | `gateway/src/scheduler/run-timeline-marks.test.ts`; `sidecar/src/run-timeline.test.ts`; the fake SDK's text-delta shape against SDK 0.3.278 in `sidecar/src/sdk-shape.container.test.ts` | marks per attempt |
| 2 | slow-start, slow-first-token, retry, resume, cancel and disconnect fixtures yield the waiting stage; missing marks are `observed: false` with null durations | `contracts/src/run-timeline.test.ts` | share of attempts with each stage not observed |
| 3 | attempts carry start, session, sandbox warmth and retry count; the report groups by them | `contracts/src/run-timeline.test.ts`; `evals/latency-report.test.ts` | attempts per class |
| 4 | marks carry wall time from their own process; the report prints the clock caveat | `evals/latency-report.test.ts` | none |
| 5 | the route returns the timeline from the whole ledger (404 for an unknown run) under the same Member policy as the context route; the run detail renders every stage, "not observed" and the longest wait | `gateway/src/scheduler/run-timeline-marks.test.ts`; `gateway/src/api/permission-matrix.test.ts`; web `runs/run-timeline.test.tsx` | none |
| 6 | the report reads a database read-only and prints p50/p95 per class, retry, failure and cache distributions | `evals/latency-report.test.ts` | e2e, TTFT and first-visible-text p50/p95 |
| 7 | only the decoded `reply` string is posted, redacted, throttled, cumulative; the Gateway publishes without a ledger row and marks the first frame; the chat replaces the preview with the final message and drops it on end, park or cancel; stale seq ignored | `sidecar/src/reply-preview.test.ts`; `gateway/src/api/reply-preview-routes.test.ts`; web `chats/reply-preview.test.tsx` | time from first text to first visible preview |
| 8 | a failing recorder or preview post leaves the run's outcome unchanged; no retry added | `sidecar/src/run-timeline.test.ts`; `sidecar/src/reply-preview.test.ts` | runs failed by observation (0) |
