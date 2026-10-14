/** Host observations only. These samples never enter model context or include tool arguments. */
export const PHASE_TIMING_VERSION = 1;

export type TimingPhase =
  | "model_request"
  | "model_headers"
  | "model_first_byte"
  | "model_body"
  | "proxy_queue"
  | "browser_before"
  | "browser_rpc"
  | "browser_after"
  | "browser_capture"
  | "browser_capture_rpc"
  | "browser_snapshot_rpc"
  | "browser_fence"
  | "origin_wait";

/**
 * A start/end pair in a run attempt's log events. Missing ends mean incomplete observation,
 * never zero work. Durations use a monotonic clock; `at` is wall time for trace correlation.
 * Nested/overlapping spans must not be summed as elapsed run time. First body byte is transport
 * latency, not first generated token; request duration includes networking and upstream work.
 */
export interface PhaseTimingSample {
  source: "phase_timing";
  version: typeof PHASE_TIMING_VERSION;
  spanId: string;
  phase: TimingPhase;
  edge: "start" | "end";
  at: string;
  parentSpanId?: string;
  durationMs?: number;
  outcome?: "ok" | "error" | "cancelled";
  toolName?: string;
  /** Fixed route category; a token-count request must not be mistaken for inference. */
  requestKind?: "messages" | "count_tokens";
}
