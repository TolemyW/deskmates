import type { RunEvent } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { RUN_ID } from "../../test-support/fixtures.js";
import { eventsShown, isDiagnosticEvent, ledgerRows } from "./ledger-rows.js";

function ev(seq: number, kind: RunEvent["kind"], payload: Record<string, unknown>, ts: string) {
  return { runId: RUN_ID, seq, kind, payload, ts } satisfies RunEvent;
}
const T = (s: number) => new Date(Date.parse("2026-10-15T10:00:00.000Z") + s * 1000).toISOString();

describe("ledger rows (issue #9)", () => {
  it("pairs a call with its result by toolUseId, wherever the result lands", () => {
    const rows = ledgerRows([
      ev(5, "tool_result", { toolUseId: "a", isError: false }, T(30)),
      ev(1, "tool_call", { toolUseId: "a", toolName: "Bash" }, T(0)),
      ev(2, "tool_call", { toolUseId: "b", toolName: "Read" }, T(1)),
      ev(3, "thinking", { text: "hm" }, T(2)),
      ev(4, "tool_result", { toolUseId: "b", isError: true }, T(1.5)),
      ev(6, "tool_call", { toolUseId: "c", toolName: "Grep" }, T(31)),
    ]);
    expect(rows.map((r) => (r.kind === "tool" ? `tool#${r.call.seq}` : `#${r.event.seq}`))).toEqual(
      ["tool#1", "tool#2", "#3", "tool#6"],
    );
    expect(rows[0]).toMatchObject({ durationMs: 30_000, isError: false, result: { seq: 5 } });
    expect(rows[1]).toMatchObject({ durationMs: 500, isError: true, result: { seq: 4 } });
    expect(rows[3]).toMatchObject({ durationMs: undefined, isError: false, result: undefined });
    expect(eventsShown(rows)).toBe(6);
  });

  it("keeps a result whose call is not loaded as its own row", () => {
    const rows = ledgerRows([ev(9, "tool_result", { toolUseId: "old", isError: false }, T(0))]);
    expect(rows).toEqual([{ kind: "event", event: expect.objectContaining({ seq: 9 }) }]);
  });

  it("collapses structured telemetry, never the run's words, errors or stalls", () => {
    const diagnostic = [
      ev(1, "log", { source: "resource_observation", memoryMb: 1 }, T(0)),
      ev(2, "log", { source: "phase_timing", phase: "model_request", edge: "start" }, T(0)),
      ev(3, "log", { source: "run_timeline", mark: "sdk_init" }, T(0)),
      ev(4, "log", { source: "sdk", usageSessionFingerprint: "f" }, T(0)),
    ];
    const visible = [
      ev(5, "log", { source: "assistant", text: "done" }, T(0)),
      ev(6, "log", { source: "sidecar", level: "error", error: "boom" }, T(0)),
      ev(7, "log", { source: "screenshot", level: "warn", action: 1 }, T(0)),
      ev(8, "log", { source: "stall", op: "stalled", idleMs: 1 }, T(0)),
      ev(9, "log", { line: "free text without a source" }, T(0)),
      ev(10, "turn_usage", { turn: 1 }, T(0)),
    ];
    for (const e of diagnostic) expect(isDiagnosticEvent(e)).toBe(true);
    for (const e of visible) expect(isDiagnosticEvent(e)).toBe(false);
    const all = [...diagnostic, ...visible];
    expect(ledgerRows(all)).toHaveLength(visible.length);
    expect(ledgerRows(all, { diagnostics: true })).toHaveLength(all.length);
  });
});
