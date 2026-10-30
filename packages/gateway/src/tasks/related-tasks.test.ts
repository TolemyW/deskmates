// T0 (ADR-0021 amendment 4, A4h): the deterministic lexical similarity used when no embedding
// service is configured or a call fails: word tokens, CJK bigrams and Jaccard.

import { describe, expect, it } from "vitest";
import { jaccard, similarityTokens } from "./related-tasks.js";

describe("lexical similarity", () => {
  it("tokenises words of two or more characters and CJK runs as bigrams", () => {
    expect([...similarityTokens("Login fails on Safari, error 503 a")].sort()).toEqual([
      "503",
      "error",
      "fails",
      "login",
      "on",
      "safari",
    ]);
    expect([...similarityTokens("登录失败")].sort()).toEqual(["失败", "登录", "录失"].sort());
    expect([...similarityTokens("Safari登录")].sort()).toEqual(["safari", "登录"].sort());
  });

  it("scores Jaccard over token sets, identical text 1 and disjoint 0", () => {
    const a = similarityTokens("Login fails on Safari");
    expect(jaccard(a, similarityTokens("login FAILS on safari"))).toBe(1);
    expect(jaccard(a, similarityTokens("Refund for order 42"))).toBe(0);
    expect(jaccard(a, similarityTokens("Login fails on Chrome"))).toBeCloseTo(3 / 5);
    expect(jaccard(new Set(), a)).toBe(0);
    // Chinese text compares by bigrams.
    expect(
      jaccard(similarityTokens("用户无法登录"), similarityTokens("用户登录失败")),
    ).toBeGreaterThan(0.2);
  });
});
