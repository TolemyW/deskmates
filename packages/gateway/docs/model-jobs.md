# Model jobs: vision probes, round triage and SOUL proposals

ADR-0023 amendment 1; issues #87, #77 and #12. All are short runs (row first) of a bot's background
lane with no tools, no session and one turn. The sidecar relays the model's text; the Gateway
grades or applies it. The Gateway never calls a model.

## Trigger kind, deadline and thinking

- Every Gateway model job, and the approval presentation, Activity summary and memory
  consolidation runs, is created with `triggerKind: "model_job"` (issue #39 item 7);
  `runs.config_json.runType` names the job and `triggerRef` is `<job kind>:<subject id>`. Rows
  written before the change keep `cron`. `GET /api/runs?triggerKind=model_job` lists them. On
  the sidecar wire a job still carries the `cron` trigger shape it always had.
- `MODEL_JOB_DEADLINE_MS` (default 55000, `config/runs.ts`) is how long a job in
  `MODEL_JOB_RUN_TYPES` may take. The Gateway sends it as `modelJobDeadlineMs` on the
  `StartRunRequest`, records it in `runs.config_json.modelJobDeadlineMs`, and kills the process
  five seconds later (never later than `RUN_TIMEOUT_SECONDS`). The default keeps ADR-0023
  decision 5's 60-second cap; the deadline error names the effective seconds
  (`model job did not finish within 55 s`).
- `MODEL_JOB_THINKING` (`disabled` by default, or `sdk-default`) is the extended thinking of a
  job on the Claude path: `disabled` sends the SDK `thinking: { type: "disabled" }`, because
  `CLAUDE_CODE_MAX_OUTPUT_TOKENS` does not bound thinking and a cheap model that thought for
  thousands of tokens ran past the deadline (issue #39 item 8). A run-level `thinking` override
  wins, a bot's reasoning override does not apply to its jobs, and the value is recorded as the
  run's `reasoning`. An upstream that refuses `disabled` fails the job visibly; set
  `sdk-default` there. The `openai-agents` runtime sends no reasoning parameter, since Chat
  Completions has none every model accepts. The approval presentation and Activity summary
  runs get the same value.
- `disabled` is not a guarantee. SDK 0.3.278 omits a disabled thinking key on the wire instead
  of sending it, and glm53 and deepseek think by default when it is absent (probe 2026-10-26),
  so on those upstreams jobs still think. A job records its thinking blocks as `thinking`
  events, as a chat run does. The Activity summary's output cap,
  `ACTIVITY_SUMMARY_MAX_OUTPUT_TOKENS` (1024), leaves room for that thinking; its reply is
  bounded by ADR-0033 decision 3, not by the cap. The cap was 256 until deepseek's thinking used
  all of it on 13 of 103 stable summaries.

## Vision probes

- Queued when a bot is created, when its `model` override changes, once at Gateway start for
  each model in use without a result, and by `POST /api/workspaces/:id/model-capabilities/vision/probe`
  (`{ model }`, Admin, at most three per model in 24 hours, `429 rate_limited` after).
  `VISION_PROBE=off` stops the automatic ones.
- `GET /api/workspaces/:id/model-capabilities` (Member) returns the current result per model in
  use. It never queues a probe.
- The probe run is frozen on the probed model only (`model` = `cheapModel`, no fallback). Its one
  message holds a synthetic PNG of a random four-digit code the Gateway chose.
- The probe keeps the SDK's default thinking whatever `MODEL_JOB_THINKING` says: it judges the
  request shape real runs send. SDK 0.3.278 sends a disabled thinking key as no key, and one
  upstream never answered an image request without the key, so every probe of that model timed
  out from 2026-10-22 while the same image with `adaptive` answered in about 5 s.
- Results, one row each in `model_capability_probes`, keyed by workspace, model, the sha256 of
  `MODEL_BASE_URL` and the adapter revision: `supported` only for the right digits and at least
  one image block on a forwarded request of the probe run (`model_requests.image_blocks`);
  `unsupported` only for an explicit "cannot see"; `unknown` with `wrong_answer`,
  `no_transport_evidence`, `job_failed` or `blocked` otherwise. Every run records
  `modelCapabilities.vision` for its frozen model at start.
- Every run except a model job also records `visionPolicy` at start (ADR-0023 amendment 2):
  `withhold` for `unsupported` and for `unknown`/`wrong_answer`, `deliver` otherwise; a resume
  keeps it. Only `withhold` reaches the sidecar, which then replaces image content with a text
  notice (`packages/sidecar/src/vision-withhold.ts`). The capabilities route returns each
  model's `visionPolicy` and the `botIds` that use it.

## Round triage

- ADR-0005 amendment 6 (proposed), `DESKMATES_GROUP_ROUTING=round-v1` only. A human request to a
  group queues a `round_triage` run of the thread's owner (or first member) on the cheap model,
  in the thread, on the background lane; it never waits for that lane (`scheduler.ts`).
- The job reads the roster (name, role, owner mark), whether the request said `@everyone`, and the
  request (at most 8,000 characters) wrapped as untrusted data, and answers one JSON object:
  `{"assignments":[{"member","task"}],"closer"}`.
- `RoundTriage.complete` keeps current members only, drops repeats and empty tasks, bounds a task to
  one line of 200 characters and replaces an invalid closer (the assigned owner, else the first
  assignee). No assignment left ends the job `failed` with a `{source: "round_triage"}` event; the
  router then falls back to `owner-v1` routing. See `docs/group-routing.md`.

## SOUL proposals

- `POST /api/bots/:id/soul-proposals` (`{ instruction }`, Admin) queues a cheap-model job against
  the current SOUL and returns `202 { proposal }` while pending. A pending proposal, or a ready one
  for the same instruction and SOUL version, is returned instead of a second job.
- An empty SOUL gets a whole draft (`mode: create`); otherwise the model returns find-and-replace
  edits that the Gateway applies to the stored base, so untouched text is byte-identical.
- `GET /api/bots/:id/soul-proposals/:proposalId` (Member) reads it;
  `POST .../apply` (Admin) writes it through the canonical SOUL write, a new numbered version:
  refused with `invalid_transition` when SOUL changed since the base; a live or parked run of the
  bot does not refuse it, the answer carries `appliesFromNextRun` (ADR-0043 decision 3);
  idempotent once applied. `POST .../discard` ends it.
- `POST /api/bots` accepts `welcome: false` to create a bot unstarted for a drafted first SOUL;
  `POST /api/bots/:id/welcome` starts it after the apply (#89 ordering).
