// T0: ADR-0033 decision 3, the counted bound of an Activity summary.

import { describe, expect, it } from "vitest";
import {
  ACTIVITY_SUMMARY_MAX_CJK,
  ACTIVITY_SUMMARY_MAX_WORDS,
  boundActivitySummary,
  fitsActivitySummary,
  isCjkText,
} from "./activity-summary.js";

const visible = (text: string) =>
  Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)).filter((s) =>
    s.segment.trim(),
  ).length;

describe("boundActivitySummary", () => {
  it("keeps short Chinese text as written", () => {
    expect(boundActivitySummary("已完成报价，等待审批。")).toBe("已完成报价，等待审批。");
    expect(fitsActivitySummary("已完成报价，等待审批。")).toBe(true);
  });

  it("cuts Chinese text to 50 graphemes including the ellipsis", () => {
    const long = "查".repeat(80);
    const out = boundActivitySummary(long);
    expect(visible(out)).toBe(ACTIVITY_SUMMARY_MAX_CJK);
    expect(out.endsWith("…")).toBe(true);
    expect(fitsActivitySummary(long)).toBe(false);
  });

  it("counts an emoji and mixed-language text as CJK graphemes", () => {
    const mixed = `${"👍🏽".repeat(10)}价格 price 上涨${"好".repeat(60)}`;
    expect(isCjkText(mixed)).toBe(true);
    const out = boundActivitySummary(mixed);
    expect(visible(out)).toBeLessThanOrEqual(ACTIVITY_SUMMARY_MAX_CJK);
    expect(out.startsWith("👍🏽")).toBe(true);
  });

  it("bounds English text to 30 words", () => {
    const words = Array.from({ length: 45 }, (_, i) => `w${i}`).join(" ");
    const out = boundActivitySummary(words);
    expect(out.split(/\s+/)).toHaveLength(ACTIVITY_SUMMARY_MAX_WORDS);
    expect(out.endsWith("w29…")).toBe(true);
  });

  it("keeps at most three lines and drops blank ones", () => {
    const out = boundActivitySummary("one\n\ntwo\nthree\nfour");
    expect(out.split("\n")).toEqual(["one", "two", "three…"]);
  });

  it("leaves one unbreakable token whole: wrapping is the card's job", () => {
    const token = "x".repeat(500);
    expect(boundActivitySummary(token)).toBe(token);
  });
});
