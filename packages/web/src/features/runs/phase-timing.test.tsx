// @vitest-environment jsdom
import type { RunEvent } from "@deskmates/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RUN_ID } from "../../test-support/fixtures.js";
import { PhaseTimingTimeline, phaseSpans } from "./phase-timing.js";

afterEach(cleanup);

const T0 = Date.parse("2026-10-15T10:00:00.000Z");
let seq = 0;
function sample(
  spanId: string,
  phase: string,
  edge: "start" | "end",
  offsetMs: number,
  extra: Record<string, unknown> = {},
): RunEvent {
  seq += 1;
  const at = new Date(T0 + offsetMs).toISOString();
  return {
    runId: RUN_ID,
    seq,
    kind: "log",
    payload: { source: "phase_timing", version: 1, spanId, phase, edge, at, ...extra },
    ts: at,
  };
}

const events = [
  sample("r", "model_request", "start", 0, { requestKind: "messages" }),
  sample("b", "model_first_byte", "start", 0, { parentSpanId: "r" }),
  sample("b", "model_first_byte", "end", 1200, {
    parentSpanId: "r",
    durationMs: 1200,
    outcome: "ok",
  }),
  sample("r", "model_request", "end", 4000, { durationMs: 4000, outcome: "ok" }),
  // Only its end was seen: started 300 ms before it ended.
  sample("x", "browser_rpc", "end", 5000, {
    durationMs: 300,
    outcome: "error",
    toolName: "browser_click",
  }),
  sample("o", "origin_wait", "start", 6000),
  { runId: RUN_ID, seq: 99, kind: "log", payload: { source: "assistant", text: "x" }, ts: "x" },
] satisfies RunEvent[];

describe("phase timing timeline (issue #9)", () => {
  it("pairs start and end by span id, nests children and keeps open spans open", () => {
    const spans = phaseSpans(events);
    expect(spans.map((s) => [s.phase, s.startMs - T0, s.durationMs, s.outcome, s.depth])).toEqual([
      ["model_request", 0, 4000, "ok", 0],
      ["model_first_byte", 0, 1200, "ok", 1],
      ["browser_rpc", 4700, 300, "error", 0],
      ["origin_wait", 6000, undefined, undefined, 0],
    ]);
  });

  it("draws one row per span with its offset, duration and outcome", () => {
    render(<PhaseTimingTimeline events={events} />);
    const rows = within(screen.getByRole("list", { name: "Phase timing spans" })).getAllByRole(
      "listitem",
    );
    expect(rows.map((r) => r.textContent)).toEqual([
      "model_request+0 s · 4 s",
      "model_first_byte+0 s · 1 s",
      "browser_rpc · browser_click+4 s · 300 ms · error",
      "origin_wait+6 s · open",
    ]);
    expect(rows[3]?.getAttribute("data-outcome")).toBe("open");
  });

  it("says so when the run recorded none", () => {
    render(<PhaseTimingTimeline events={[]} />);
    expect(screen.getByText("No phase timing recorded.")).toBeTruthy();
  });
});
