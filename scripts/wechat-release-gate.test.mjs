import { describe, expect, it } from "vitest";
import { wechatPluginEntries, wechatReleaseReady } from "./wechat-release-gate.mjs";

describe("WeChat release acceptance gate", () => {
  const record = Array.from(
    { length: 8 },
    (_, i) => `| W${i + 1} | passed | Dated account test receipt |`,
  ).join("\n");
  it("requires every gate and its evidence, never treats unknown or missing results as a pass", () => {
    expect(wechatReleaseReady(record)).toBe(true);
    for (const state of ["failed", "blocked", "not run", ""])
      expect(wechatReleaseReady(record.replace("passed", state))).toBe(false);
    expect(wechatReleaseReady(record.split("\n").slice(1).join("\n"))).toBe(false);
  });
  it("keeps the current unverified plugin out of release builds, with an explicit development entry", () => {
    expect(wechatPluginEntries()).toEqual([]);
    expect(() => wechatPluginEntries({ required: true })).toThrow(/W1–W8/);
    expect(wechatPluginEntries({ development: true })).toEqual([
      { id: "wechat", version: "1.0.0", apiVersion: 2, entry: "wechat/plugin.js" },
    ]);
  });
});
