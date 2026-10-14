import type { M2Assessment } from "./m2-assessment.js";

export type AbArm = "A" | "B";
export declare const AB_ARMS: readonly ["A", "B"];
export declare const DEFAULT_AB_ROUNDS: number;
export declare const MAX_AB_ROUNDS: number;
export declare const TOKEN_KEYS: readonly [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheCreateTokens",
];
export declare const UNKNOWN: "unknown";

/** A count the ledger saw, or `"unknown"` when it saw none; never a zero standing in for unknown. */
export type TokenCount = number | "unknown";
export interface AbTokens {
  inputTokens: TokenCount;
  outputTokens: TokenCount;
  cacheReadTokens: TokenCount;
  cacheCreateTokens: TokenCount;
}

export interface AbConfig {
  modelA: string;
  modelB: string;
  rounds: number;
}

/** One run inside a round; further evidence fields (events, reply, config) ride along. */
export interface AbRunRow {
  id: string;
  bot: string;
  status: string;
  tokens: AbTokens;
  [key: string]: unknown;
}

/** One row per (arm, round) in results.json. */
export interface AbRow {
  arm: AbArm;
  model: string;
  round: number;
  label: string;
  passed: boolean;
  wallMs: number;
  /** The three dimensions from `assessFoundationCase`; absent only when no bots were created. */
  assessment: M2Assessment | undefined;
  /** Sum over `runs`; unknown when any run's usage is unknown. */
  tokens: AbTokens;
  runs: AbRunRow[];
  [key: string]: unknown;
}

export interface AbArmSummary {
  arm: AbArm;
  model: string;
  rows: number;
  passed: number;
  wallMs: { median: number; min: number; max: number } | null;
  tokens: AbTokens;
  runsMissingUsage: number;
}

export interface AbSummary {
  rounds: number;
  arms: AbArmSummary[];
  caveat: string;
}

/** Read the campaign configuration; throws when either model id is unset or rounds are invalid. */
export declare function readAbConfig(env: Record<string, string | undefined>): AbConfig;
/** One run's tokens over its usage rows; no rows means unknown, never zero. */
export declare function runTokens(usageRows: readonly object[]): AbTokens;
/** Sum token counts; one unknown makes that key's total unknown. */
export declare function sumTokens(list: readonly AbTokens[]): AbTokens;
/** What `rounds` rounds per arm can and cannot resolve. */
export declare function abSampleSizeCaveat(rounds: number): string;
export declare function summarizeAbRows(
  rows: readonly AbRow[],
  models: Record<AbArm, string>,
  rounds: number,
): AbSummary;
/** The per-arm lines followed by the sample-size caveat. */
export declare function formatAbSummary(summary: AbSummary): string;
