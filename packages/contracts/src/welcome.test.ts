import { describe, expect, it } from "vitest";
import type { BotId, RunId, ThreadId } from "./ids.js";
import type { RunStatus } from "./run.js";
import { canRetryWelcome, isWelcomeGreeting, welcomeDelivery } from "./welcome.js";

const run = { id: "run_w" as RunId, botId: "bot_a" as BotId, threadId: "thr_a" as ThreadId };
const greeting = {
  threadId: "thr_a" as ThreadId,
  authorKind: "bot" as const,
  authorId: "bot_a",
  runId: "run_w" as RunId,
};

describe("welcome delivery (ADR-0024 amendment 2, decision 11)", () => {
  it("attributes only the run's own bot message in its own thread", () => {
    expect(isWelcomeGreeting(run, greeting)).toBe(true);
    expect(isWelcomeGreeting(run, { ...greeting, threadId: "thr_bus" as ThreadId })).toBe(false);
    expect(isWelcomeGreeting(run, { ...greeting, runId: "run_other" as RunId })).toBe(false);
    expect(isWelcomeGreeting(run, { ...greeting, authorId: "bot_b" })).toBe(false);
    expect(isWelcomeGreeting(run, { ...greeting, authorKind: "system" })).toBe(false);
    const { runId: _omit, ...unattributed } = greeting;
    expect(isWelcomeGreeting(run, unattributed)).toBe(false);
    const { threadId: _none, ...threadless } = run;
    expect(isWelcomeGreeting(threadless, greeting)).toBe(false);
  });

  it("treats a silent welcome that posted as delivered and only an empty one as retryable", () => {
    const cases: [RunStatus, boolean, string][] = [
      ["queued", false, "pending"],
      ["running", true, "pending"],
      ["waiting_approval", false, "pending"],
      ["succeeded", false, "delivered"],
      ["succeeded", true, "delivered"],
      ["silent", true, "delivered"],
      ["silent", false, "undelivered"],
      ["failed", false, "undelivered"],
      ["failed", true, "partial"],
      ["cancelled", true, "partial"],
      ["stopped", false, "undelivered"],
    ];
    for (const [status, posted, expected] of cases) {
      const delivery = welcomeDelivery({ status }, posted);
      expect([status, posted, delivery]).toEqual([status, posted, expected]);
      expect(canRetryWelcome(delivery)).toBe(expected === "undelivered");
    }
  });
});
