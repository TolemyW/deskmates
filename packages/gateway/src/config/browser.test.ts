// T0, ADR-0002 amendment 5, C5 (issue #78): the browser-code tier knob defaults to today's
// behaviour and refuses anything it does not know.

import { describe, expect, it } from "vitest";
import { readBrowserConfig } from "./browser.js";

describe("BROWSER_CODE_APPROVAL", () => {
  it("defaults to name-v1 when unset or empty", () => {
    expect(readBrowserConfig({}).browserCodeApproval).toBe("name-v1");
    expect(readBrowserConfig({ BROWSER_CODE_APPROVAL: " " }).browserCodeApproval).toBe("name-v1");
  });

  it("accepts the opt-in effects-v1", () => {
    expect(readBrowserConfig({ BROWSER_CODE_APPROVAL: "effects-v1" }).browserCodeApproval).toBe(
      "effects-v1",
    );
  });

  it("fails startup on any other value", () => {
    expect(() => readBrowserConfig({ BROWSER_CODE_APPROVAL: "all" })).toThrow(
      /BROWSER_CODE_APPROVAL/,
    );
  });
});
