// Workspace monetary budget (ADR-0032): two optional USD limits, spend from the Gateway's charge
// ledger, and parks that wait for a manual continue. Money only; tokens are usage, never budget.

import type { BotId, RunId, ThreadId, WorkspaceId } from "./ids.js";
import type { RunStatus } from "./run.js";

/** Method version of the unknown-price estimate (ADR-0032 decision 4). */
export const PRICE_ESTIMATE_VERSION = "avg-unit-price-v1";

/** The `error` of a run that hit the budget with no SDK session to resume (decision 6). */
export const RUN_ERROR_BUDGET = "budget_exhausted";

export type BudgetLimitKind = "weekly" | "cumulative";
/** Where the park happened: before a start or resume, or before a model call. */
export type BudgetCheckpoint = "admission" | "model_call";

export interface BudgetLimits {
  /** USD per week (Monday 00:00 UTC); null means no weekly limit. */
  weeklyLimitUsd: number | null;
  /** USD since the workspace began; null means no ceiling. */
  cumulativeLimitUsd: number | null;
}

export interface BudgetSpend {
  knownUsd: number;
  /** Spend priced by the average-unit-price estimate; never a provider charge. */
  estimatedUsd: number;
  /** Known plus estimated: what admission compares with a limit. */
  totalUsd: number;
  /** Usage rows whose tokens were never measured; they charge nothing. */
  unmeasuredUsageCount: number;
  /** Usage rows with tokens but neither a price nor an estimate. */
  unestimatedUsageCount: number;
}

export interface BudgetPark {
  id: string;
  workspaceId: WorkspaceId;
  runId: RunId;
  botId: BotId;
  botName: string;
  threadId?: ThreadId;
  runStatus: RunStatus;
  attempt: number;
  checkpoint: BudgetCheckpoint;
  limitKind: BudgetLimitKind;
  spendUsd: number;
  limitUsd: number;
  parkedAt: string;
}

export interface WorkspaceBudget {
  workspaceId: WorkspaceId;
  workspaceName: string;
  limits: BudgetLimits;
  updatedAt?: string;
  updatedBy?: string;
  week: { startsAt: string; endsAt: string; spend: BudgetSpend };
  cumulative: BudgetSpend;
  /** The limit currently reached, weekly first; null while admission admits. */
  exhausted: BudgetLimitKind | null;
  /** Open parks: work "budget insufficient, waiting to continue". */
  parks: BudgetPark[];
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Monday 00:00 UTC of the week holding `at` (decision 2), whatever the local time zone. */
export function weekStartUtc(at: Date): Date {
  const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  // getUTCDay: Sunday 0 .. Saturday 6; Monday is the first day of the week.
  const sinceMonday = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - sinceMonday * 24 * 60 * 60 * 1000);
}

/** The next Monday 00:00 UTC after `at`'s week start. */
export function weekEndUtc(at: Date): Date {
  return new Date(weekStartUtc(at).getTime() + WEEK_MS);
}
