// Workspace execution limits (ADR-0005 amendment 5, ADR-0016 amendment 2): the message caps, the
// per-attempt turn cap and the continuation limit as audited per-workspace settings, two switches
// beside them, and the Gateway loop breaker that stands behind them. Owner rulings of 2026-10-14:
// the turn budget and the volume rule are off by default, and `off` needs no money budget unless
// the workspace turns on `requireBudgetForOff`.

import { RELAY_COUNT_MAX } from "./thread.js";

/** Every limit a workspace may store, sorted. */
export const WORKSPACE_LIMIT_KEYS = [
  "continuationLimit",
  "continuationWindowHours",
  "maxTurns",
  "relayCountMax",
  "turnBudget",
  "turnBudgetResetMinutes",
] as const;
export type WorkspaceLimitKey = (typeof WORKSPACE_LIMIT_KEYS)[number];

/** A stored setting: a number in range, or `off`. */
export type WorkspaceLimitValue = number | "off";

/** What a workspace stores; an absent key inherits. */
export type WorkspaceLimitSettings = Partial<Record<WorkspaceLimitKey, WorkspaceLimitValue>>;

/**
 * The workspace switches, sorted; an absent switch is off (ADR-0005 amendment 5 decisions 39
 * and 40). `requireBudgetForOff`: "require a budget for unlimited limits". `volumeBreaker`: the
 * loop breaker's bot-message volume rule.
 */
export const WORKSPACE_LIMIT_SWITCH_KEYS = ["requireBudgetForOff", "volumeBreaker"] as const;
export type WorkspaceLimitSwitchKey = (typeof WORKSPACE_LIMIT_SWITCH_KEYS)[number];
export type WorkspaceLimitSwitches = Record<WorkspaceLimitSwitchKey, boolean>;

/**
 * Where an effective value came from. `default_no_backstop` is an `off` that resolves to a number
 * because the workspace requires a budget for unlimited limits and has none (decision 39).
 */
export type WorkspaceLimitSource =
  | "workspace"
  | "thread"
  | "gateway"
  | "default"
  | "default_no_backstop"
  | "loop_breaker";

/** An effective limit; `value` null means off (no count cap; the loop breaker still applies). */
export interface EffectiveLimit {
  value: number | null;
  source: WorkspaceLimitSource;
}

export interface WorkspaceLimitRange {
  min: number;
  max: number;
  /** Whether `off` may be stored. */
  off: boolean;
}

/** Loop breaker (ADR-0005 amendment 5, decision 40): Gateway constants, not settings. */
export const LOOP_BREAKER_RELAY_MAX = 50;
/** The volume rule's threshold; the rule itself is the `volumeBreaker` switch, off by default. */
export const LOOP_BREAKER_BOT_MESSAGES = 300;
/** A bot's third identical message since the latest human message trips the breaker. */
export const LOOP_BREAKER_REPEATS = 3;
export type LoopBreakerRule = "depth" | "volume" | "repetition";

/** ADR-0016 decisions 4 and 5: the defaults the settings inherit from. */
export const CONTINUATION_LIMIT_DEFAULT = 2;
export const CONTINUATION_WINDOW_HOURS_DEFAULT = 24;
/**
 * ADR-0005 amendment 3, rewritten decision 22: a turn-budget pause ends by itself this many
 * minutes after it began. The default is a guess, justified in the ADR and calibrated by
 * `budget_pause_rate` and re-breaches after an automatic resume.
 */
export const TURN_BUDGET_RESET_MINUTES_DEFAULT = 60;

export const WORKSPACE_LIMIT_RANGES: Readonly<Record<WorkspaceLimitKey, WorkspaceLimitRange>> = {
  continuationLimit: { min: 0, max: 20, off: true },
  continuationWindowHours: { min: 1, max: 168, off: false },
  maxTurns: { min: 1, max: 1000, off: true },
  relayCountMax: { min: 1, max: LOOP_BREAKER_RELAY_MAX, off: true },
  turnBudget: { min: 1, max: LOOP_BREAKER_BOT_MESSAGES, off: true },
  // Never off: a turn-budget pause always ends by itself (owner, 2026-10-17).
  turnBudgetResetMinutes: { min: 5, max: 1440, off: false },
};

/**
 * The values a workspace with no settings gets; `maxTurns` is the Gateway's configured value and
 * null is off (the turn budget, owner 2026-10-14).
 */
export function workspaceLimitDefaults(
  gatewayMaxTurns: number,
): Readonly<Record<WorkspaceLimitKey, number | null>> {
  return {
    continuationLimit: CONTINUATION_LIMIT_DEFAULT,
    continuationWindowHours: CONTINUATION_WINDOW_HOURS_DEFAULT,
    maxTurns: gatewayMaxTurns,
    relayCountMax: RELAY_COUNT_MAX,
    turnBudget: null,
    turnBudgetResetMinutes: TURN_BUDGET_RESET_MINUTES_DEFAULT,
  };
}

/** `GET /api/workspaces/:id/limits`. */
export interface WorkspaceLimitsView {
  workspaceId: string;
  settings: WorkspaceLimitSettings;
  /** Every switch, absent ones false. */
  switches: WorkspaceLimitSwitches;
  /**
   * Effective values for runs and messages of this workspace. `turnBudget` here is the
   * workspace-level value; under `requireBudgetForOff` without a budget a thread's default `off`
   * falls back to its own row (source `default_no_backstop`).
   */
  effective: Record<WorkspaceLimitKey, EffectiveLimit>;
  /** null is off. */
  defaults: Record<WorkspaceLimitKey, number | null>;
  ranges: Record<WorkspaceLimitKey, WorkspaceLimitRange>;
  loopBreaker: { relayMax: number; botMessages: number; repeats: number };
  /** Whether a weekly or cumulative monetary limit is set (ADR-0032). */
  budgetBackstop: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

/**
 * `PUT /api/workspaces/:id/limits`: a limit set to null clears it (inherit); a switch is a
 * boolean, and false clears it.
 */
export type WorkspaceLimitsInput = Partial<
  Record<WorkspaceLimitKey, WorkspaceLimitValue | null> & Record<WorkspaceLimitSwitchKey, boolean>
>;
