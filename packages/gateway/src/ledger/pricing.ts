// Pure pricing (ADR-0002 item 5): cost_usd = Σ tokens × price(model, kind, effective_at).
// The SDK's costUSD is ignored. An unknown model prices to null, never to zero.

import type { ModelPrice, RunUsage } from "@deskmates/contracts";

export type UsageCounts = Pick<
  RunUsage,
  "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreateTokens"
>;

/**
 * The price row in force for `model` at `at`: the newest row whose `effectiveFrom <= at`.
 * Rows that only take effect after `at` are ignored, so a re-priced run keeps its historical cost.
 */
export function selectPrice(
  prices: readonly ModelPrice[],
  model: string,
  at: string,
): ModelPrice | undefined {
  let best: ModelPrice | undefined;
  for (const p of prices) {
    if (p.model !== model || p.effectiveFrom > at) continue;
    if (!best || p.effectiveFrom > best.effectiveFrom) best = p;
  }
  return best;
}

/** USD for one (run, model) usage row, or null when the model has no price at `at`. */
export function priceUsage(
  prices: readonly ModelPrice[],
  model: string,
  usage: UsageCounts,
  at: string,
): number | null {
  const p = selectPrice(prices, model, at);
  if (!p) return null;
  const perM = 1_000_000;
  const cost =
    (usage.inputTokens * p.inputPerM +
      usage.outputTokens * p.outputPerM +
      usage.cacheReadTokens * p.cacheReadPerM +
      usage.cacheCreateTokens * p.cacheCreatePerM) /
    perM;
  // Round to micro-dollars so a ledger sum does not drift on float noise.
  return Math.round(cost * 1e6) / 1e6;
}
