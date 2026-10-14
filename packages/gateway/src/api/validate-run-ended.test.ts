import type { RunId } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { asRunEnded } from "./validate.js";

const runId = "run-test" as RunId;

describe("run end protocol validation", () => {
  it("retains a turn-exhaustion handoff and host learning marks", () => {
    const ended = asRunEnded(runId, {
      type: "run_ended",
      outcome: "turns_exhausted",
      sdkSessionId: "session-1",
      handoffPath: "/work/handoffs/run-test-attempt-1.md",
      usage: [],
      summary: {
        done: "partial",
        reply: "",
        filesChanged: [],
        sitesVisited: [],
        pendingApprovals: [],
        memorySuggestions: [],
        learned: [
          {
            body: "Tool unavailable",
            proposedScope: "bot",
            authority: "fact",
            turn: 4,
            sourceKind: "tool",
            trust: "untrusted",
            doNotLearnReasons: ["transport_error"],
          },
        ],
      },
      taint: { turns: 4, doNotLearnReasons: ["transport_error"] },
    });
    expect(ended.outcome).toBe("turns_exhausted");
    expect(ended.handoffPath).toBe("/work/handoffs/run-test-attempt-1.md");
    expect(ended.summary?.learned?.[0]?.doNotLearnReasons).toEqual(["transport_error"]);
    expect(ended.taint?.doNotLearnReasons).toEqual(["transport_error"]);
  });

  it("drops an invalid handoff path and unknown learning reason", () => {
    const ended = asRunEnded(runId, {
      type: "run_ended",
      outcome: "turns_exhausted",
      usage: [],
      handoffPath: "/home/other/SOUL.md",
      taint: { turns: 1, doNotLearnReasons: ["not-a-reason"] },
    });
    expect(ended.handoffPath).toBeUndefined();
    expect(ended.taint?.doNotLearnReasons).toBeUndefined();
  });
});
