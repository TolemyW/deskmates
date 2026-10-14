import { describe, expect, it } from "vitest";
import {
  isEffortLevel,
  isRecordedReasoning,
  isThinkingConfig,
  overridesOfRecorded,
  resolveReasoning,
} from "./reasoning.js";

describe("reasoning knob", () => {
  it("accepts the SDK's effort levels and thinking shapes and nothing else", () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"])
      expect(isEffortLevel(level)).toBe(true);
    for (const bad of ["", "HIGH", "ultra", 3, null]) expect(isEffortLevel(bad)).toBe(false);
    expect(isThinkingConfig({ type: "adaptive" })).toBe(true);
    expect(isThinkingConfig({ type: "disabled" })).toBe(true);
    expect(isThinkingConfig({ type: "enabled" })).toBe(true);
    expect(isThinkingConfig({ type: "enabled", budgetTokens: 2048 })).toBe(true);
    for (const bad of [
      { type: "adaptive", budgetTokens: 1 },
      { type: "enabled", budgetTokens: 0 },
      { type: "enabled", budgetTokens: 1.5 },
      { type: "on" },
      "adaptive",
      null,
      [],
    ])
      expect(isThinkingConfig(bad), JSON.stringify(bad)).toBe(false);
  });

  it("records sdk-default when nothing is set and sends nothing to the sidecar", () => {
    expect(resolveReasoning({}, {})).toEqual({
      recorded: {
        effort: "sdk-default",
        thinking: "sdk-default",
        effortSource: "sdk-default",
        thinkingSource: "sdk-default",
      },
      request: {},
    });
  });

  it("lets the run override the bot and records where each value came from", () => {
    const resolved = resolveReasoning(
      { effort: "low" },
      { effort: "xhigh", thinking: { type: "adaptive" } },
    );
    expect(resolved).toEqual({
      recorded: {
        effort: "low",
        thinking: { type: "adaptive" },
        effortSource: "run",
        thinkingSource: "bot",
      },
      request: { effort: "low", thinking: { type: "adaptive" } },
    });
    expect(overridesOfRecorded(resolved.recorded)).toEqual({
      effort: "low",
      thinking: { type: "adaptive" },
    });
    expect(overridesOfRecorded(resolveReasoning({}, {}).recorded)).toEqual({});
    expect(isRecordedReasoning(resolved.recorded)).toBe(true);
    expect(isRecordedReasoning({ effort: "sdk-default" })).toBe(false);
  });
});
