// The message caps of ADR-0005 decision 6, as configured per workspace (amendment 5, decisions
// 37 to 39), and the loop breaker that stands behind them (decision 40). Pure: the router hands
// in the counts and the effective caps, and acts on what comes back.

import {
  type EffectiveLimit,
  LOOP_BREAKER_BOT_MESSAGES,
  LOOP_BREAKER_RELAY_MAX,
  LOOP_BREAKER_REPEATS,
  type LoopBreakerRule,
  RELAY_COUNT_MAX,
  type WakeBlockedReason,
  type WorkspaceLimitSource,
} from "@deskmates/contracts";
import type { ThreadCaps } from "../limits/workspace-limits.js";

export type CapName = "relay_count" | "turn_budget" | "loop_breaker";

export interface CapBreach {
  cap: CapName;
  /** Whether the thread pauses (a volume trip) or only this message's wakes are dropped. */
  pauses: boolean;
  limit: number;
  source: WorkspaceLimitSource;
  rule?: LoopBreakerRule;
}

/** Caps of a router built without workspace limits: decision 6 as first written. */
export function fixedCaps(threadTurnBudget: number): ThreadCaps {
  return {
    turnBudget: { value: threadTurnBudget, source: "thread" },
    relayCountMax: { value: RELAY_COUNT_MAX, source: "default" },
    relaxed: false,
  };
}

/** Trim, collapse whitespace and fold case: the body the repetition rule compares. */
export function normalizeBody(body: string): string {
  return body.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * What one stored bot message breaches. `botCount` includes the message; `repeats` is how many
 * messages of its author since the latest human message have its normalized body, itself
 * included. At most one depth breach and one volume breach are returned.
 */
export function evaluateCaps(
  caps: ThreadCaps,
  counts: { relayCount: number; botCount: number; repeats: number },
): CapBreach[] {
  const breaches: CapBreach[] = [];
  breaches.push(...depth(caps.relayCountMax, counts.relayCount));
  if (caps.turnBudget.value !== null && counts.botCount >= caps.turnBudget.value) {
    breaches.push({
      cap: "turn_budget",
      pauses: true,
      limit: caps.turnBudget.value,
      source: caps.turnBudget.source,
    });
  } else if (counts.botCount >= LOOP_BREAKER_BOT_MESSAGES) {
    breaches.push(breaker("volume", LOOP_BREAKER_BOT_MESSAGES, true));
  } else if (caps.relaxed && counts.repeats >= LOOP_BREAKER_REPEATS) {
    breaches.push(breaker("repetition", LOOP_BREAKER_REPEATS, true));
  }
  return breaches;
}

function depth(relay: EffectiveLimit, relayCount: number): CapBreach[] {
  if (relay.value === null)
    return relayCount > LOOP_BREAKER_RELAY_MAX
      ? [breaker("depth", LOOP_BREAKER_RELAY_MAX, false)]
      : [];
  return relayCount > relay.value
    ? [{ cap: "relay_count", pauses: false, limit: relay.value, source: relay.source }]
    : [];
}

function breaker(rule: LoopBreakerRule, limit: number, pauses: boolean): CapBreach {
  return { cap: "loop_breaker", pauses, limit, source: "loop_breaker", rule };
}

/** What the posting run is told (`thread_post` routing): a pause wins over a dropped hop. */
export function blockedReason(breaches: readonly CapBreach[]): WakeBlockedReason | undefined {
  if (breaches.length === 0) return undefined;
  return breaches.some((breach) => breach.pauses) ? "turn_budget" : "relay_count";
}

/** The notice label, keeping decision 6's wording ("turn budget reached") first. */
export function breachLabel(breach: CapBreach): string {
  const source =
    breach.source === "workspace"
      ? "workspace setting"
      : breach.source === "default_no_backstop"
        ? "default; off needs a budget"
        : breach.source;
  if (breach.cap === "relay_count") return `relay cap reached (${breach.limit} hops, ${source})`;
  if (breach.cap === "turn_budget")
    return `turn budget reached (${breach.limit} bot messages, ${source})`;
  const what =
    breach.rule === "depth"
      ? `${breach.limit} hops`
      : breach.rule === "volume"
        ? `${breach.limit} bot messages`
        : `${breach.limit} identical messages from one bot`;
  return `loop breaker tripped (${what})`;
}
