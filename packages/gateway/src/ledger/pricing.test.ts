import type { ModelPrice } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { priceUsage, selectPrice } from "./pricing.js";

const PRICES: ModelPrice[] = [
  {
    model: "model-a",
    inputPerM: 3,
    outputPerM: 15,
    cacheReadPerM: 0.3,
    cacheCreatePerM: 3.75,
    effectiveFrom: "2026-01-01T00:00:00.000Z",
  },
  {
    model: "model-a",
    inputPerM: 2,
    outputPerM: 10,
    cacheReadPerM: 0.2,
    cacheCreatePerM: 2.5,
    effectiveFrom: "2026-06-01T00:00:00.000Z",
  },
  {
    model: "model-b",
    inputPerM: 1,
    outputPerM: 5,
    cacheReadPerM: 0.1,
    cacheCreatePerM: 1.25,
    effectiveFrom: "2026-01-01T00:00:00.000Z",
  },
];

describe("pricing (ADR-0002 item 5; test strategy §4.2 T0 pricing)", () => {
  it("sums the four token kinds at the model's per-million rates", () => {
    const cost = priceUsage(
      PRICES,
      "model-b",
      { inputTokens: 1_000_000, outputTokens: 200_000, cacheReadTokens: 0, cacheCreateTokens: 0 },
      "2026-03-01T00:00:00.000Z",
    );
    expect(cost).toBe(1 + 1);
  });

  it("applies the cache discount: cache reads cost the cache-read rate, not the input rate", () => {
    const at = "2026-03-01T00:00:00.000Z";
    const uncached = priceUsage(
      PRICES,
      "model-a",
      { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
      at,
    );
    const cached = priceUsage(
      PRICES,
      "model-a",
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheCreateTokens: 0 },
      at,
    );
    const created = priceUsage(
      PRICES,
      "model-a",
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 1_000_000 },
      at,
    );
    expect(uncached).toBe(3);
    expect(cached).toBe(0.3);
    expect(created).toBe(3.75);
  });

  it("picks the price row in force at the run time (effective date)", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    };
    expect(priceUsage(PRICES, "model-a", usage, "2026-05-31T23:59:59.000Z")).toBe(3);
    expect(priceUsage(PRICES, "model-a", usage, "2026-06-01T00:00:00.000Z")).toBe(2);
    expect(selectPrice(PRICES, "model-a", "2025-12-31T00:00:00.000Z")).toBeUndefined();
  });

  it("returns null, not zero, for an unknown model", () => {
    expect(
      priceUsage(
        PRICES,
        "model-nobody-knows",
        { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheCreateTokens: 0 },
        "2026-03-01T00:00:00.000Z",
      ),
    ).toBeNull();
  });

  it("rounds to micro-dollars", () => {
    expect(
      priceUsage(
        PRICES,
        "model-b",
        { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheCreateTokens: 1 },
        "2026-03-01T00:00:00.000Z",
      ),
    ).toBe(0.000007);
  });
});
