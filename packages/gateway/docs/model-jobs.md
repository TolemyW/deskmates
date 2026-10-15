# Model jobs: vision probes, round triage and SOUL proposals

ADR-0023 amendment 1; issues #87, #77 and #12. All are short runs (row first) of a bot's background
lane with no tools, no session and one turn. The sidecar relays the model's text; the Gateway
grades or applies it. The Gateway never calls a model.

## Vision probes

- Queued when a bot is created, when its `model` override changes, once at Gateway start for
  each model in use without a result, and by `POST /api/workspaces/:id/model-capabilities/vision/probe`
  (`{ model }`, Admin, at most three per model in 24 hours, `429 rate_limited` after).
  `VISION_PROBE=off` stops the automatic ones.
- `GET /api/workspaces/:id/model-capabilities` (Member) returns the current result per model in
  use. It never queues a probe.
- The probe run is frozen on the probed model only (`model` = `cheapModel`, no fallback). Its one
  message holds a synthetic PNG of a random four-digit code the Gateway chose.
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
