// T0: the contract between the MCP proxy (which captures) and the run process (which emits).

import { describe, expect, it } from "vitest";
import {
  SCREENSHOT_MAX_BYTES,
  SCREENSHOT_MAX_PER_RUN,
  isPageChangingBrowserTool,
  parseScreenshotFile,
  screenshotFileName,
} from "./screenshots.js";

describe("isPageChangingBrowserTool", () => {
  it.each([
    "browser_navigate",
    "mcp__browser__browser_navigate",
    "mcp__browser__browser_click",
    "mcp__browser__browser_type",
    "mcp__browser__browser_fill_form",
    "mcp__browser__browser_select_option",
    "mcp__browser__browser_press_key",
    "mcp__browser__browser_navigate_back",
    "mcp__browser__browser_tabs",
  ])("captures after %s", (name) => {
    expect(isPageChangingBrowserTool(name)).toBe(true);
  });

  it.each([
    "mcp__browser__browser_snapshot",
    "mcp__browser__browser_take_screenshot",
    "mcp__browser__browser_find",
    "mcp__browser__browser_console_messages",
    "mcp__browser__browser_network_requests",
    "mcp__browser__browser_wait_for",
    "Bash",
    "Write",
    "mcp__deskmates__thread_post",
    "mcp__other__browser_click",
  ])("never captures after %s", (name) => {
    expect(isPageChangingBrowserTool(name)).toBe(false);
  });
});

describe("capture files", () => {
  it("are named by the action count", () => {
    expect(screenshotFileName(1)).toBe("1.json");
    expect(screenshotFileName(12)).toBe("12.json");
  });

  it("parse when complete and reject a partial write", () => {
    const file = {
      action: 3,
      toolName: "browser_click",
      mimeType: "image/jpeg",
      base64: "/9j/4AAQ",
      bytes: 6,
      takenAt: "2026-09-22T10:00:00.000Z",
    };
    expect(parseScreenshotFile(JSON.stringify(file))).toEqual(file);
    expect(parseScreenshotFile(JSON.stringify(file).slice(0, 40))).toBeUndefined();
    expect(parseScreenshotFile(JSON.stringify({ action: "3" }))).toBeUndefined();
  });

  it("caps are stated numbers the proxy and the run process share", () => {
    expect(SCREENSHOT_MAX_PER_RUN).toBe(40);
    expect(SCREENSHOT_MAX_BYTES).toBe(300_000);
  });
});
