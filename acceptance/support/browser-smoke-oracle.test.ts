import { describe, expect, it } from "vitest";
import { browserSmokeOracle, formatBrowserSmokeFailures } from "./browser-smoke-oracle.js";

const tasks = [
  { label: "tickets", expectedReply: "answer: 0" },
  { label: "revenue", expectedReply: "answer: 0.00" },
];

const events = (tabId: string) => [
  { kind: "log", payload: { source: "browser_lock", tabId } },
  { kind: "tool_result", payload: { isError: false } },
  { kind: "screenshot", payload: { tabId } },
];

describe("browserSmokeOracle", () => {
  it("passes the exact reply and every runtime/session check", () => {
    const oracle = browserSmokeOracle(
      tasks,
      [
        { status: "succeeded", summary: { reply: "answer: 0" } },
        { status: "succeeded", summary: { reply: "answer: 0.00" } },
      ],
      [events("tab-a"), events("tab-b")],
      1,
    );

    expect(oracle.passed).toBe(true);
    expect(oracle.failures).toEqual([]);
    expect(oracle.checks).toHaveLength(10);
  });

  it("reports a strict format miss after evaluating runtime and shared-session facts", () => {
    const oracle = browserSmokeOracle(
      tasks,
      [
        { status: "succeeded", summary: { reply: "answer: 0" } },
        { status: "succeeded", summary: { reply: "The dashboard shows 0.00." } },
      ],
      [events("tab-a"), events("tab-b")],
      2,
    );

    expect(oracle.passed).toBe(false);
    expect(oracle.checks).toHaveLength(10);
    expect(oracle.failures.map((failure) => failure.name)).toEqual([
      "revenue exact reply",
      "shared authenticated session",
    ]);
    expect(formatBrowserSmokeFailures(oracle)).toContain(
      'revenue exact reply: expected "answer: 0.00", got "The dashboard shows 0.00."',
    );
    expect(formatBrowserSmokeFailures(oracle)).toContain(
      "shared authenticated session: expected 1, got 2",
    );
  });

  it("rejects empty attribution, missing tool results and any screenshot from a peer tab", () => {
    const oracle = browserSmokeOracle(
      tasks,
      [
        { status: "succeeded", summary: { reply: "answer: 0" } },
        { status: "succeeded", summary: { reply: "answer: 0.00" } },
      ],
      [
        [
          { kind: "log", payload: { source: "browser_lock", tabId: "tab-a" } },
          { kind: "screenshot", payload: { tabId: "tab-a" } },
          { kind: "screenshot", payload: { tabId: "tab-peer" } },
        ],
        [
          { kind: "log", payload: { source: "browser_lock", tabId: "" } },
          { kind: "tool_result", payload: { isError: false } },
          { kind: "screenshot", payload: { tabId: "" } },
        ],
      ],
      1,
    );

    expect(oracle.failures.map((failure) => failure.name)).toEqual([
      "runs acquired attributed tabs",
      "runs used distinct tabs",
      "tickets tool results succeeded",
      "tickets screenshot matched tab",
      "revenue screenshot matched tab",
    ]);
  });
});
