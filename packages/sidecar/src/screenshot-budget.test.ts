import { expect, it, vi } from "vitest";
import { screenshotRecorder } from "./screenshot-budget.js";
it("shares one capture budget across MCP and CLI without charging rejected oversized captures", () => {
  const emit = vi.fn();
  const record = screenshotRecorder({ emit });
  expect(record({ toolName: "mcp__deskmates__browser_cli_workflow", bytes: 300001 })).toBe(false);
  for (let i = 0; i < 39; i++)
    expect(record({ toolName: "mcp__browser__browser_click", bytes: 100 })).toBe(true);
  expect(record({ toolName: "mcp__deskmates__browser_cli_workflow", bytes: 100 })).toBe(true);
  expect(record({ toolName: "mcp__browser__browser_click", bytes: 100 })).toBe(false);
  expect(emit).toHaveBeenCalledTimes(40);
  expect(emit.mock.lastCall?.[1]).toMatchObject({
    captureIndex: 40,
    toolName: "mcp__deskmates__browser_cli_workflow",
  });
});
