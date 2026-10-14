// Compact token counts keep three significant digits (owner, 2026-10-10): a cost tile that
// rounds 999,999 to "1M" hides a difference worth a budget. Below 1,000 the count is shown whole.

import { describe, expect, it } from "vitest";
import { compactTokens } from "./costs.js";

describe("compactTokens", () => {
  it("shows counts under a thousand whole", () => {
    expect(compactTokens(0)).toBe("0");
    expect(compactTokens(42)).toBe("42");
    expect(compactTokens(999)).toBe("999");
  });

  it("keeps three significant digits in thousands", () => {
    expect(compactTokens(1_000)).toBe("1.00K");
    expect(compactTokens(1_234)).toBe("1.23K");
    expect(compactTokens(15_246)).toBe("15.2K");
    expect(compactTokens(152_460)).toBe("152K");
  });

  it("keeps three significant digits across the million boundary", () => {
    expect(compactTokens(999_499)).toBe("999K");
    expect(compactTokens(999_999)).toBe("1.00M");
    expect(compactTokens(1_500_000)).toBe("1.50M");
    expect(compactTokens(12_345_678)).toBe("12.3M");
    expect(compactTokens(123_456_789)).toBe("123M");
  });
});
