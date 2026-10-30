// Number formats of the Costs page. Money and tokens never share a formatter, so a value cannot
// change unit on its way to the screen (ADR-0032 decision 9).

import type { CostTotals, OperationUnit } from "@deskmates/contracts";
import { currentI18n } from "../../i18n/intl.js";

/** A token or run count with the active locale's digit grouping. */
export function tokens(value: number): string {
  return value.toLocaleString(currentI18n().locale);
}

/**
 * Compact token counts for tiles and bars, always three significant digits in the locale's own
 * units: 1.23K, 15.2K, 152K, 1.00M in English; 1.52万 in Chinese. Three digits because a tile
 * that says "1M" for 999,999 tokens hides a budget's worth of difference (owner, 2026-10-10).
 */
export function compactTokens(value: number): string {
  const locale = currentI18n().locale;
  if (value < 1_000) return value.toLocaleString(locale);
  return value.toLocaleString(locale, {
    notation: "compact",
    minimumSignificantDigits: 3,
    maximumSignificantDigits: 3,
  });
}

/** US dollars with a fixed number of decimals, written the active locale's way. */
function usd(value: number, decimals: number): string {
  return value.toLocaleString(currentI18n().locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: false,
  });
}

export function dollars(value: number): string {
  return usd(value, 2);
}

/** Spend for a tile: cents matter, micro-dollars do not. */
export function shortDollars(value: number): string {
  return usd(value, 2);
}

export function totalTokens(t: CostTotals): number {
  return t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheCreateTokens;
}

/** Known plus estimated USD; null when there is neither (unpriced, never zero). */
export function moneyOf(t: CostTotals): number | null {
  const estimated = t.estimatedCostUsd ?? null;
  if (t.knownCostUsd === null && estimated === null) return null;
  return Math.round(((t.knownCostUsd ?? 0) + (estimated ?? 0)) * 1e6) / 1e6;
}

/** Whether a money figure includes an estimate. */
export function hasEstimate(t: CostTotals): boolean {
  return (t.estimatedCostUsd ?? 0) > 0;
}

/**
 * An operation quantity in its own unit (ADR-0040 amendment A): images and pages as counts,
 * audio seconds as minutes. Never converted to tokens or money.
 */
export function operationQuantity(unit: OperationUnit, quantity: number): string {
  const locale = currentI18n().locale;
  if (unit === "audio_second")
    return (quantity / 60).toLocaleString(locale, { maximumFractionDigits: 1 });
  return quantity.toLocaleString(locale, { maximumFractionDigits: 0 });
}
