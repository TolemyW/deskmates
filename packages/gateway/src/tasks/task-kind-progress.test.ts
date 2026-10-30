// T0 (ADR-0021 amendment 4, A4e): criteria progress from checkpoints and deliveries by label, the
// last mention winning; the current stage; required checkpoints; discrepancies named only.

import { describe, expect, it } from "vitest";
import { builtinTemplate } from "./builtin-templates.js";
import { type ProgressReport, kindProgress, namesLabel } from "./task-kind-progress.js";

const support = builtinTemplate("builtin:support-ticket");
if (!support) throw new Error("missing built-in");

const checkpoint = (
  at: string,
  completed: [string, number][],
  outstanding: string[] = [],
): ProgressReport => ({
  source: "checkpoint",
  createdAt: at,
  completed: completed.map(([unit, n]) => ({
    unit,
    outcome: "done",
    evidence: Array.from({ length: n }, (_, i) => `/work/e${i}.txt`),
  })),
  outstanding,
});

describe("namesLabel", () => {
  it("matches a label at the start, bracketed or not, never a longer label", () => {
    expect(namesLabel("triage.1 classified as billing", "triage.1")).toBe(true);
    expect(namesLabel("[TRIAGE.1] classified", "triage.1")).toBe(true);
    expect(namesLabel("triage.10 classified", "triage.1")).toBe(false);
    expect(namesLabel("classified triage.1", "triage.1")).toBe(false);
    expect(namesLabel("triage: everything", "triage")).toBe(true);
  });
});

describe("kindProgress", () => {
  it("starts unreported, at the first stage, with every required checkpoint missing", () => {
    const p = kindProgress(support, "planned", []);
    expect(p.criteria.map((c) => c.state)).toEqual(Array(6).fill("unreported"));
    expect(p.currentStage).toBe("triage");
    expect(p.missingCheckpoints).toEqual(["triage", "resolve"]);
    expect(p.discrepancies).toEqual([]);
  });

  it("moves criteria by the last mention in Gateway time, whatever the input order", () => {
    const reports: ProgressReport[] = [
      checkpoint("2026-10-18T03:00:00.000Z", [["triage.2 reproduced", 0]]),
      checkpoint(
        "2026-10-18T01:00:00.000Z",
        [["triage.1 recorded", 2]],
        ["triage.2 not reproduced yet"],
      ),
      {
        source: "delivery",
        createdAt: "2026-10-18T04:00:00.000Z",
        completed: [],
        outstanding: ["confirm.2 waiting for the customer"],
      },
    ];
    const p = kindProgress(support, "in_progress", reports);
    const state = Object.fromEntries(p.criteria.map((c) => [c.label, [c.state, c.evidence]]));
    expect(state).toEqual({
      "triage.1": ["met", 2],
      "triage.2": ["met", 0],
      "resolve.1": ["unreported", 0],
      "resolve.2": ["unreported", 0],
      "confirm.1": ["unreported", 0],
      "confirm.2": ["open", 0],
    });
    expect(p.currentStage).toBe("resolve");
    expect(p.missingCheckpoints).toEqual(["resolve"]);
  });

  it("names a delivered task's missing checkpoint and open criteria, never correcting them", () => {
    const p = kindProgress(support, "delivered", [
      checkpoint("2026-10-18T01:00:00.000Z", [["triage.1 ok", 1]], ["confirm.1 no reply sent"]),
    ]);
    expect(p.discrepancies).toEqual([
      { kind: "delivered_missing_checkpoint", items: ["resolve"] },
      { kind: "delivered_open_criteria", items: ["confirm.1"] },
    ]);
    // A delivery's outstanding list is not a checkpoint: it never satisfies a required stage.
    const delivery = kindProgress(support, "planned", [
      {
        source: "delivery",
        createdAt: "2026-10-18T01:00:00.000Z",
        completed: [],
        outstanding: ["resolve.1"],
      },
    ]);
    expect(delivery.missingCheckpoints).toEqual(["triage", "resolve"]);
  });
});
