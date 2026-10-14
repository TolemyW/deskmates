import type { BotId, WorkspaceId } from "./ids.js";

export type CostStatus = "priced" | "partial" | "unpriced";
export interface CostQuery {
  from?: string;
  to?: string;
  /** One workspace's runs only (cost alert rules are per workspace, ADR-0031 Q3). */
  workspaceId?: WorkspaceId;
  botId?: BotId;
  model?: string;
}
export interface CostTotals {
  usageCoverage?: "complete" | "partial" | "unknown" | "not_started";
  attributionUncertain?: boolean;
  runCount: number;
  usageCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  pricedUsageCount: number;
  unpricedUsageCount: number;
  knownCostUsd: number | null;
  costStatus: CostStatus;
  /**
   * Cost of unpriced usage at the average configured unit price per token category (ADR-0032
   * decision 4); null when nothing was estimated. Never a provider charge, never part of
   * `knownCostUsd`.
   */
  estimatedCostUsd?: number | null;
  /** Unpriced usage rows that received an estimate. */
  estimatedUsageCount?: number;
  /** Unpriced usage rows with tokens but no estimate (no configured price at all). */
  unestimatedUsageCount?: number;
}
export interface CostRow extends CostTotals {
  day: string;
  botId: BotId;
  botName: string;
  model: string;
  workspaceId?: WorkspaceId;
  workspaceName?: string;
}
/** Totals for one UTC day of the range, for the chart. */
export interface CostDay extends CostTotals {
  day: string;
}
/** How the estimate in a report was made (ADR-0032 decision 4). */
export interface CostEstimateInfo {
  version: string;
}
export interface CostReport {
  filters: CostQuery;
  totals: CostTotals;
  /**
   * Every row of the range. `GET /api/costs` no longer sends them (#113): it is the summary
   * (totals and days); the rows come a page at a time from `GET /api/costs/rows`.
   */
  rows?: CostRow[];
  /** Per-day totals over the whole filtered range, oldest first. */
  days?: CostDay[];
  estimate?: CostEstimateInfo;
}

/** What a ranking groups by (ADR-0032 decision 9). */
export type CostRankingDimension = "model" | "bot" | "workspace";
/** Money ranks known plus estimated USD; usage ranks total tokens. Units never mix. */
export type CostRankingMetric = "money" | "usage";
export interface CostRankingEntry extends CostTotals {
  key: string;
  label: string;
  /** For a bot: its workspace, so two bots of the same name are told apart. */
  workspaceId?: WorkspaceId;
  workspaceName?: string;
}
export interface CostRankingPage {
  by: CostRankingDimension;
  metric: CostRankingMetric;
  filters: CostQuery;
  entries: CostRankingEntry[];
  /** Entries in the whole ranking, not on this page. */
  total: number;
  offset: number;
  limit: number;
}
export const COST_RANKING_PAGE_SIZE = 10;

/**
 * `GET /api/costs/rows` (#113): one keyset page of the Activity rows (one per day, bot and model),
 * newest day first, then bot name, bot id and model. `nextCursor` is present when more rows
 * follow; `total` counts every row of the filtered range. Totals and days never come from here.
 */
export interface CostRowPage {
  filters: CostQuery;
  rows: CostRow[];
  nextCursor?: string;
  total: number;
}
export const COST_ROWS_PAGE_SIZE = 10;
