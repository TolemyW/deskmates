// The unknown-price estimate (ADR-0032 decision 4). A usage row whose model has no price in
// force is priced, category by category, at the mean unit price of the models that do have one
// at that time. Request totals are never averaged; an unmeasured category stays unknown; an
// empty price table gives no estimate at all. Pure, so the cost report and the budget agree.

import type { ModelPrice } from "@deskmates/contracts";

export interface AverageUnitPrice {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM: number;
  cacheCreatePerM: number;
  /** Configured models whose in-force row was averaged. */
  populationSize: number;
}

/** Token counts as receipts hold them: null is unknown, never zero. */
export interface MeasuredCounts {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreateTokens: number | null;
}

/** Per-category mean over the newest row of each model with `effectiveFrom <= at`. */
export function averageUnitPrice(
  prices: readonly ModelPrice[],
  at: string,
): AverageUnitPrice | undefined {
  const inForce = new Map<string, ModelPrice>();
  for (const p of prices) {
    if (p.effectiveFrom > at) continue;
    const best = inForce.get(p.model);
    if (!best || p.effectiveFrom > best.effectiveFrom) inForce.set(p.model, p);
  }
  // A model priced at an explicit zero (a local model, ADR-0039 decision 5) says nothing about
  // what an unpriced paid model costs, so it is left out of the population (decision 7).
  const rows = [...inForce.values()].filter(
    (p) => p.inputPerM + p.outputPerM + p.cacheReadPerM + p.cacheCreatePerM > 0,
  );
  if (!rows.length) return undefined;
  const mean = (key: "inputPerM" | "outputPerM" | "cacheReadPerM" | "cacheCreatePerM") =>
    rows.reduce((sum, p) => sum + p[key], 0) / rows.length;
  return {
    inputPerM: mean("inputPerM"),
    outputPerM: mean("outputPerM"),
    cacheReadPerM: mean("cacheReadPerM"),
    cacheCreatePerM: mean("cacheCreatePerM"),
    populationSize: rows.length,
  };
}

/** USD for the measured categories, or null when nothing was measured or there is no average. */
export function estimateCost(
  average: AverageUnitPrice | undefined,
  counts: MeasuredCounts,
): number | null {
  if (!average) return null;
  const parts: [number | null, number][] = [
    [counts.inputTokens, average.inputPerM],
    [counts.outputTokens, average.outputPerM],
    [counts.cacheReadTokens, average.cacheReadPerM],
    [counts.cacheCreateTokens, average.cacheCreatePerM],
  ];
  if (parts.every(([n]) => n === null)) return null;
  const usd = parts.reduce((sum, [n, perM]) => sum + ((n ?? 0) * perM) / 1_000_000, 0);
  return Math.round(usd * 1e6) / 1e6;
}

/** Whether a receipt row measured any tokens at all. */
export function measured(counts: MeasuredCounts): boolean {
  return (
    counts.inputTokens !== null ||
    counts.outputTokens !== null ||
    counts.cacheReadTokens !== null ||
    counts.cacheCreateTokens !== null
  );
}

/** Caches the average per pricing instant for one report over one price table. */
export class EstimateCache {
  private readonly byAt = new Map<string, AverageUnitPrice | undefined>();
  constructor(private readonly prices: readonly ModelPrice[]) {}
  at(at: string): AverageUnitPrice | undefined {
    if (!this.byAt.has(at)) this.byAt.set(at, averageUnitPrice(this.prices, at));
    return this.byAt.get(at);
  }
}
