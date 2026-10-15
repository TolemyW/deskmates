/** Operator context measurements derived from recorded events; missing measurements are null. */
export interface RunCompaction {
  attempt: number;
  seq: number;
  trigger: string;
  preTokens: number;
  postTokens?: number;
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
   * The context window the CLI was given (`CLAUDE_CODE_MAX_CONTEXT_TOKENS`): the latest attempt's
   * `sdk` init log, else what `RunEnded` reported. Null when the run's CLI got none, which is the
   * default; the CLI then picks its own window and the meter has no denominator (issue #9).
   */
  maxContextTokens: number | null;
  modelRequests: { count: number; distinctSystemHashes: number; changedWithinAttempt: boolean };
}
