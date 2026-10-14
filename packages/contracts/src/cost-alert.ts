// Cost alerts (ADR-0018): soft thresholds on Gateway-priced usage. A rule never changes what a
// run may do; it only says when an operator is told. Windows are UTC calendar units, the same
// bucketing `GET /api/costs` uses, so an alert and the Costs screen always agree.

import type { CostTotals } from "./cost.js";
import type { BotId, IsoTimestamp, RunId, WorkspaceId } from "./ids.js";
import type { OffsetPageMeta } from "./pagination.js";

export const COST_ALERT_WINDOWS = ["day", "month"] as const;
export type CostAlertWindow = (typeof COST_ALERT_WINDOWS)[number];

export function isCostAlertWindow(value: unknown): value is CostAlertWindow {
  return typeof value === "string" && (COST_ALERT_WINDOWS as readonly string[]).includes(value);
}

/**
 * `known_cost` fires when the window's known cost reaches `thresholdUsd`; `unpriced_usage` fires
 * when the window holds at least one usage row with no price, so unknown spend is surfaced
 * instead of being read as zero (ADR-0018 decision 1).
 */
export const COST_ALERT_KINDS = ["known_cost", "unpriced_usage"] as const;
export type CostAlertKind = (typeof COST_ALERT_KINDS)[number];

export function isCostAlertKind(value: unknown): value is CostAlertKind {
  return typeof value === "string" && (COST_ALERT_KINDS as readonly string[]).includes(value);
}

export interface CostAlertRule {
  id: string;
  kind: CostAlertKind;
  window: CostAlertWindow;
  /** The workspace the rule covers (ADR-0031 Q3); the Gateway always sets it. */
  workspaceId?: WorkspaceId;
  /** One bot, or every bot of the workspace when absent. */
  botId?: BotId;
  /** Required for `known_cost`, absent for `unpriced_usage`. USD. */
  thresholdUsd?: number;
  /** `human:<authorId>`, as approvals record their decider. */
  createdBy: string;
  createdAt: IsoTimestamp;
}

export interface CreateCostAlertRuleInput {
  kind: CostAlertKind;
  window: CostAlertWindow;
  /**
   * The workspace of an every-bot rule. A bot rule takes its bot's workspace. Without either, the
   * Gateway uses the tenant's only active workspace and refuses when there are several.
   */
  workspaceId?: WorkspaceId;
  botId?: BotId;
  thresholdUsd?: number;
  createdBy: string;
}

/** One firing of a rule in one window (ADR-0018 decisions 3 and 4). */
export interface CostAlert {
  id: string;
  ruleId: string;
  kind: CostAlertKind;
  window: CostAlertWindow;
  /** `YYYY-MM-DD` for a day window, `YYYY-MM` for a month window; unique per rule. */
  windowKey: string;
  botId?: BotId;
  thresholdUsd?: number;
  /** The run whose usage made the rule true; it carries the matching `cost_alert` event. */
  runId: RunId;
  /** The window's totals as the cost report computed them when the alert fired. */
  totals: CostTotals;
  firedAt: IsoTimestamp;
  acknowledgedAt?: IsoTimestamp;
  acknowledgedBy?: string;
}

/**
 * `GET /api/cost-alerts` (#113): one keyset page of alerts, newest first (`fired_at DESC, id
 * DESC`). `total` counts every alert under the same status filter, which is the badge's number;
 * `nextCursor` is present when more alerts follow.
 */
export interface CostAlertPage {
  alerts: CostAlert[];
  nextCursor?: string;
  total: number;
}

/** `GET /api/cost-alert-rules` (#113): one offset page of rules, oldest first, with the total. */
export interface CostAlertRulePage extends OffsetPageMeta {
  rules: CostAlertRule[];
}

/** Payload of the `cost_alert` run event; the same facts as the alert row, flattened. */
export interface CostAlertEventPayload {
  alertId: string;
  ruleId: string;
  kind: CostAlertKind;
  window: CostAlertWindow;
  windowKey: string;
  botId: BotId | null;
  thresholdUsd: number | null;
  knownCostUsd: number | null;
  unpricedUsageCount: number;
  runCount: number;
  usageCount: number;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** The UTC window `at` falls in: `2026-10-02` or `2026-10`. */
export function costAlertWindowKey(window: CostAlertWindow, at: Date): string {
  const month = `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}`;
  return window === "day" ? `${month}-${pad(at.getUTCDate())}` : month;
}

/** Inclusive `YYYY-MM-DD` bounds of the window `at` falls in, in the cost report's query shape. */
export function costAlertWindowRange(
  window: CostAlertWindow,
  at: Date,
): { from: string; to: string } {
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth();
  if (window === "day") {
    const day = costAlertWindowKey("day", at);
    return { from: day, to: day };
  }
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const prefix = `${year}-${pad(month + 1)}`;
  return { from: `${prefix}-01`, to: `${prefix}-${pad(lastDay)}` };
}

/** Whether `totals` satisfy a rule (ADR-0018 decision 1). Pure; the store decides deduplication. */
export function costAlertRuleSatisfied(
  rule: Pick<CostAlertRule, "kind" | "thresholdUsd">,
  totals: CostTotals,
): boolean {
  if (rule.kind === "unpriced_usage") return totals.unpricedUsageCount > 0;
  if (rule.thresholdUsd === undefined || totals.knownCostUsd === null) return false;
  return totals.knownCostUsd >= rule.thresholdUsd;
}
