// Workspace execution limits (ADR-0005 amendment 5, ADR-0016 amendment 2): the message caps, the
// per-attempt turn cap and the continuation limit as audited per-workspace settings, and the
// Gateway loop breaker that stands behind them. Defaults are unchanged; a new workspace stores
// nothing and behaves exactly as before.

import { RELAY_COUNT_MAX, TURN_BUDGET_DEFAULT } from "./thread.js";

/** Every limit a workspace may store, sorted. */
export const WORKSPACE_LIMIT_KEYS = [
  "continuationLimit",
  "continuationWindowHours",
  "maxTurns",
  "relayCountMax",
  "turnBudget",
] as const;
export type WorkspaceLimitKey = (typeof WORKSPACE_LIMIT_KEYS)[number];

/** A stored setting: a number in range, or `off` (needs a monetary limit, decision 39). */
export type WorkspaceLimitValue = number | "off";

/** What a workspace stores; an absent key inherits. */
export type WorkspaceLimitSettings = Partial<Record<WorkspaceLimitKey, WorkspaceLimitValue>>;

/**
 * Where an effective value came from. `default_no_backstop` is a stored `off` that resolves to
 * the default because the workspace has no monetary limit (ADR-0005 amendment 5, decision 39).
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
export const LOOP_BREAKER_BOT_MESSAGES = 100;
/** A bot's third identical message since the latest human message trips the breaker. */
export const LOOP_BREAKER_REPEATS = 3;
export type LoopBreakerRule = "depth" | "volume" | "repetition";

/** ADR-0016 decisions 4 and 5: the defaults the settings inherit from. */
export const CONTINUATION_LIMIT_DEFAULT = 2;
export const CONTINUATION_WINDOW_HOURS_DEFAULT = 24;

export const WORKSPACE_LIMIT_RANGES: Readonly<Record<WorkspaceLimitKey, WorkspaceLimitRange>> = {
  continuationLimit: { min: 0, max: 20, off: true },
  continuationWindowHours: { min: 1, max: 168, off: false },
  maxTurns: { min: 1, max: 1000, off: true },
  relayCountMax: { min: 1, max: LOOP_BREAKER_RELAY_MAX, off: true },
  turnBudget: { min: 1, max: LOOP_BREAKER_BOT_MESSAGES, off: true },
};

/** The values a workspace with no settings gets; `maxTurns` is the Gateway's configured value. */
export function workspaceLimitDefaults(
  gatewayMaxTurns: number,
): Readonly<Record<WorkspaceLimitKey, number>> {
  return {
    continuationLimit: CONTINUATION_LIMIT_DEFAULT,
    continuationWindowHours: CONTINUATION_WINDOW_HOURS_DEFAULT,
    maxTurns: gatewayMaxTurns,
    relayCountMax: RELAY_COUNT_MAX,
    turnBudget: TURN_BUDGET_DEFAULT,
  };
}

/** `GET /api/workspaces/:id/limits`. */
export interface WorkspaceLimitsView {
  workspaceId: string;
  settings: WorkspaceLimitSettings;
  /**
   * Effective values for runs and messages of this workspace. `turnBudget` here is the
   * workspace-level value; a thread without a workspace setting uses its own row (source
   * `thread`).
   */
  effective: Record<WorkspaceLimitKey, EffectiveLimit>;
  defaults: Record<WorkspaceLimitKey, number>;
  ranges: Record<WorkspaceLimitKey, WorkspaceLimitRange>;
  loopBreaker: { relayMax: number; botMessages: number; repeats: number };
  /** Whether a weekly or cumulative monetary limit is set (ADR-0032), which `off` needs. */
  budgetBackstop: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

/** `PUT /api/workspaces/:id/limits`: a key set to null clears it (inherit). */
export type WorkspaceLimitsInput = Partial<Record<WorkspaceLimitKey, WorkspaceLimitValue | null>>;
