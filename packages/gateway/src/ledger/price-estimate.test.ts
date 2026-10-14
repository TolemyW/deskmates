// T0: the unknown-price estimate (ADR-0032 decision 4).

import type { ModelPrice } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { averageUnitPrice, estimateCost } from "./price-estimate.js";

const row = (
  model: string,
  perM: [number, number, number, number],
  from = "2020-01-01T00:00:00.000Z",
): ModelPrice => ({
  model,
  inputPerM: perM[0],
  outputPerM: perM[1],
  cacheReadPerM: perM[2],
  cacheCreatePerM: perM[3],
  effectiveFrom: from,
});

const AT = "2026-10-13T00:00:00.000Z";

describe("average configured unit price (ADR-0032 decision 4)", () => {
  it("averages each category over the in-force row of every configured model", () => {
    const avg = averageUnitPrice(
      [
        row("a", [2, 10, 0.2, 2.5]),
        row("b", [4, 20, 0.4, 5.5]),
        // An older row of `a` is replaced by its newer one, not averaged in.
        row("a", [100, 100, 100, 100], "2019-01-01T00:00:00.000Z"),
      ],
      AT,
    );
    expect(avg).toEqual({
      inputPerM: 3,
      outputPerM: 15,
      cacheReadPerM: expect.closeTo(0.3, 10),
      cacheCreatePerM: 4,
      populationSize: 2,
    });
  });

  it("is not a mean of request totals", () => {
    // Model a is cheap on input, b on output. A mean of totals would weight by what was used;
    // the unit-price mean is the same whatever the traffic.
    const avg = averageUnitPrice([row("a", [1, 100, 0, 0]), row("b", [100, 1, 0, 0])], AT);
    expect(
      estimateCost(avg, {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
      }),
    ).toBe(50.5);
  });

  it("excludes a row that takes effect later", () => {
    const avg = averageUnitPrice(
      [row("a", [2, 2, 2, 2]), row("b", [8, 8, 8, 8], "2027-01-01T00:00:00.000Z")],
      AT,
    );
    expect(avg?.populationSize).toBe(1);
    expect(avg?.inputPerM).toBe(2);
  });

  it("gives no estimate for an empty table, and keeps unknown categories unknown", () => {
    expect(averageUnitPrice([], AT)).toBeUndefined();
    expect(
      estimateCost(undefined, {
        inputTokens: 10,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
      }),
    ).toBeNull();
    const avg = averageUnitPrice([row("a", [1, 2, 3, 4])], AT);
    expect(
      estimateCost(avg, {
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreateTokens: null,
      }),
    ).toBeNull();
    // Only measured categories are priced: 1M output at $2.
    expect(
      estimateCost(avg, {
        inputTokens: null,
        outputTokens: 1_000_000,
        cacheReadTokens: null,
        cacheCreateTokens: null,
      }),
    ).toBe(2);
  });
});
