// The obs views a dashboard may read (ADR-0046 decision 1), sorted. This package imports nothing,
// so the list is its own copy of the contract's `OBSERVABILITY_VIEWS`; `spec.test.ts` checks it
// against the views the sqlite sink's schema creates, and compiles every query in a database that
// holds these views' columns and nothing else.

export const OBS_VIEWS = [
  "approval_requests_named",
  "approval_waits",
  "failure_matches",
  "model_latency",
  "model_request_timing",
  "phase_spans",
  "request_cache",
  "requests_named",
  "run_metrics",
  "runs_latest",
  "runs_named",
  "tool_calls",
  "watermarks",
] as const;

export type ObsView = (typeof OBS_VIEWS)[number];
