import { describe, expect, it } from "vitest";
import { TurnWarning } from "./turn-warning.js";

describe("turn exhaustion warning", () => {
  it("warns once after turn seven of twelve, counting a split response once", () => {
    const warning = new TurnWarning(12);
    for (let i = 1; i <= 6; i++) {
      warning.observeAssistant(`response-${i}`);
      expect(warning.afterTool()).toBeUndefined();
    }
    warning.observeAssistant("response-7");
    warning.observeAssistant("response-7");
    expect(warning.afterTool()).toContain("5 assistant turns remain");
    expect(warning.afterTool()).toBeUndefined();
    warning.observeAssistant("response-8");
    expect(warning.afterTool()).toBeUndefined();
  });

  it("never warns when the workspace switched turn counting off (ADR-0016 amendment 2)", () => {
    const warning = new TurnWarning(null);
    for (let i = 1; i <= 200; i++) {
      warning.observeAssistant(`response-${i}`);
      expect(warning.afterTool()).toBeUndefined();
    }
  });
});
