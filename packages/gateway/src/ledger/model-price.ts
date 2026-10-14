// Parsing a price row from untrusted text: the `MODEL_PRICES` environment variable at startup and
// the body of `PUT /api/prices`. One parser for both, so a table that starts the Gateway is a
// table the route accepts and the other way round.
//
// Nothing here names a model: the Gateway prices whatever models an operator loads (AGENTS.md
// "The Gateway prices tokens", "The model is configuration").

import { DeskmatesError, type ModelPrice } from "@deskmates/contracts";

/**
 * What a row with no `effectiveFrom` gets. The epoch, not "now": a price loaded today is meant to
 * price the runs that already happened, and a row dated now would leave them unpriced forever.
 */
export const EPOCH_EFFECTIVE_FROM = "1970-01-01T00:00:00.000Z";

const RATE_KEYS = ["inputPerM", "outputPerM", "cacheReadPerM", "cacheCreatePerM"] as const;

function fail(where: string, message: string, details: Record<string, unknown> = {}): never {
  throw new DeskmatesError("validation", `${where}: ${message}`, details);
}

/** One `{model, inputPerM, outputPerM, cacheReadPerM, cacheCreatePerM, effectiveFrom?}`. */
export function parseModelPrice(raw: unknown, where: string): ModelPrice {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(where, "each price must be a JSON object", { got: typeof raw });
  }
  const row = raw as Record<string, unknown>;
  const model = row.model;
  if (typeof model !== "string" || model.trim() === "") {
    fail(where, "each price needs a non-empty string model", { got: model });
  }
  const rates: Record<string, number> = {};
  for (const key of RATE_KEYS) {
    const v = row[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      fail(where, `${key} must be a non-negative number of USD per million tokens`, {
        model,
        key,
        got: v,
      });
    }
    rates[key] = v;
  }
  let effectiveFrom = EPOCH_EFFECTIVE_FROM;
  if (row.effectiveFrom !== undefined && row.effectiveFrom !== null) {
    if (typeof row.effectiveFrom !== "string" || Number.isNaN(Date.parse(row.effectiveFrom))) {
      fail(where, "effectiveFrom must be an ISO timestamp", { model, got: row.effectiveFrom });
    }
    // Normalised, because `selectPrice` compares these as strings.
    effectiveFrom = new Date(row.effectiveFrom).toISOString();
  }
  return {
    model: model as string,
    inputPerM: rates.inputPerM as number,
    outputPerM: rates.outputPerM as number,
    cacheReadPerM: rates.cacheReadPerM as number,
    cacheCreatePerM: rates.cacheCreatePerM as number,
    effectiveFrom,
  };
}

/** An array of rows. */
export function parseModelPrices(raw: unknown, where: string): ModelPrice[] {
  if (!Array.isArray(raw)) fail(where, "expected a JSON array of price rows", { got: typeof raw });
  return raw.map((row, i) => parseModelPrice(row, `${where}[${i}]`));
}
