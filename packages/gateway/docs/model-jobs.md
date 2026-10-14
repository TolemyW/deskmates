# Model jobs: vision probes and SOUL proposals

ADR-0023 amendment 1; issues #87 and #77. Both are short runs (row first) of a bot's background
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

## SOUL proposals

- `POST /api/bots/:id/soul-proposals` (`{ instruction }`, Admin) queues a cheap-model job against
  the current SOUL and returns `202 { proposal }` while pending. A pending proposal, or a ready one
  for the same instruction and SOUL version, is returned instead of a second job.
- An empty SOUL gets a whole draft (`mode: create`); otherwise the model returns find-and-replace
  edits that the Gateway applies to the stored base, so untouched text is byte-identical.
- `GET /api/bots/:id/soul-proposals/:proposalId` (Member) reads it;
  `POST .../apply` (Admin) writes it through the canonical SOUL write: refused with
  `invalid_transition` when SOUL changed since the base or a run is parked, `lane_busy` while the
  bot has a live run; idempotent once applied. `POST .../discard` ends it.
- `POST /api/bots` accepts `welcome: false` to create a bot unstarted for a drafted first SOUL;
  `POST /api/bots/:id/welcome` starts it after the apply (#89 ordering).
