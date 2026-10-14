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
  modelRequests: { count: number; distinctSystemHashes: number; changedWithinAttempt: boolean };
}
