/** Operator context measurements derived from recorded events; missing measurements are null. */
export interface RunCompaction {
  attempt: number;
  seq: number;
  trigger: string;
  preTokens: number;
  postTokens?: number;
}

/** One `context_usage` sample: the CLI's own view of the window (ADR-0023 amendment 5). */
export interface RunContextUsageSample {
  attempt: number;
  detail: "summary" | "full";
  /** 0 for the sample taken after init, else the model response it follows. */
  turn: number;
  totalTokens: number;
  maxTokens: number;
  percentage: number;
  /** Each category the CLI reported, by its display name; free space and buffer included. */
  categories: { name: string; kind: string; tokens: number }[];
}

/** One `SessionStart` hook call (ADR-0023 amendment 5); resume fields are null on a fresh start. */
export interface RunSessionStart {
  attempt: number;
  source: string;
  contextTokens: number | null;
  promptCacheLikelyExpired: boolean | null;
}

/**
 * The model proxy's request shapes over a run's forwarded `messages` requests (ADR-0023
 * amendment 5). "Static" is the system prefix a request marks cacheable, "dynamic" the rest.
 */
export interface RunRequestShapeSummary {
  /** Requests that carried a shape; the rest predate it or had an unreadable body. */
  measured: number;
  /** Requests with at least one `cache_control` marker. */
  withCacheControl: number;
  distinctStaticHashes: number;
  distinctDynamicHashes: number;
  staticChangedWithinAttempt: boolean;
  /** Positions of the system blocks whose hash took more than one value across the requests. */
  changedSystemBlocks: number[];
  maxSystemChars: number;
  maxToolsCount: number;
  maxToolsChars: number;
  maxMessages: number;
}

export interface RunContextMetrics {
  turns: number;
  peakInputTokens: number | null;
  p95InputTokens: number | null;
  cacheHitRatio: number | null;
  compactions: RunCompaction[];
  contextSections: Record<string, number> | null;
  systemPromptSha256: string | null;
  /**
   * ADR-0023 amendment 5: the latest attempt's static and dynamic system-prompt hashes from its
   * `context_sections` event; null when it has none (a run before the amendment, or no dynamic
   * part).
   */
  systemPromptStaticSha256?: string | null;
  systemPromptDynamicSha256?: string | null;
  modelRequests: { count: number; distinctSystemHashes: number; changedWithinAttempt: boolean };
  /**
   * ADR-0023 amendment 5. Optional so a reader built before it still type-checks; the Gateway
   * always fills them. The first sample is the per-category breakdown at start, the latest the
   * newest total.
   */
  contextUsage?: {
    samples: number;
    first: RunContextUsageSample | null;
    latest: RunContextUsageSample | null;
  };
  sessionStarts?: RunSessionStart[];
  requestShapes?: RunRequestShapeSummary | null;
}
