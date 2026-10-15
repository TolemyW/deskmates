// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { runEvent } from "../../test-support/fixtures.js";
import { RunEventRow } from "./run-event-row.js";

afterEach(cleanup);

function summaryOf(event: ReturnType<typeof runEvent>): string | null | undefined {
  const { container } = render(
    <ol>
      <RunEventRow event={event} />
    </ol>,
  );
  return container.querySelector(".event-summary")?.textContent;
}

describe("one-line ledger rows (issue #9)", () => {
  it.each([
    [
      runEvent(1, "turn_usage", {
        model: "m-large",
        turn: 3,
        inputTokens: 1200,
        outputTokens: 56,
        cacheReadTokens: 40000,
        cacheCreateTokens: null,
      }),
      "turn 3 · m-large · input 1,200 · output 56 · cache read 40,000 · cache write —",
    ],
    [
      runEvent(2, "model_switch", { from: "m-large", to: "m-small", source: "auto" }),
      "model m-large → m-small (auto)",
    ],
    [
      runEvent(3, "compact_boundary", { trigger: "auto", preTokens: 150000, postTokens: 40000 }),
      "compacted (auto): 150,000 → 40,000 tokens",
    ],
    [
      runEvent(4, "compact_boundary", { trigger: "manual", preTokens: 90000 }),
      "compacted (manual) at 90,000 tokens",
    ],
    [runEvent(5, "skill_used", { skill: "deploy-check", toolUseId: "t" }), "skill deploy-check"],
    [
      runEvent(6, "log", { source: "stall", op: "resumed", idleMs: 412000, stallSeconds: 300 }),
      "moving again after 6 min 52 s",
    ],
  ])("reads %#", (event, text) => {
    expect(summaryOf(event)).toBe(text);
  });
});
