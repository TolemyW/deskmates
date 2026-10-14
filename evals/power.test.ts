// T0: the minimum detectable effect of measurement §4.4.

import { describe, expect, it } from "vitest";
import { main, minimumDetectableEffect, powerReport, runsNeeded } from "./power.js";

describe("runsNeeded (measurement §4.4 table)", () => {
  it("matches the table: about 230 runs for 10 points from 0.80, about 900 for 5", () => {
    expect(runsNeeded(0.8, 0.1)).toBeGreaterThan(220);
    expect(runsNeeded(0.8, 0.1)).toBeLessThan(235);
    expect(runsNeeded(0.8, 0.05)).toBeGreaterThan(840);
    expect(runsNeeded(0.8, 0.05)).toBeLessThan(910);
  });
});

describe("minimumDetectableEffect", () => {
  it("inverts runsNeeded", () => {
    const n = runsNeeded(0.8, 0.1);
    expect(minimumDetectableEffect(n, 0.8)).toBeCloseTo(0.1, 6);
  });

  it("the default 44 tasks × K=5 detect about 10 points and not 5 (evals/README.md)", () => {
    const r = powerReport(44, 5, 0.8);
    expect(r.optimistic).toBeGreaterThan(0.095);
    expect(r.optimistic).toBeLessThan(0.11);
    expect(r.optimistic).toBeGreaterThan(0.05);
    // Counting each task once is the conservative bound.
    expect(r.conservative).toBeGreaterThan(r.optimistic);
  });

  it("shrinks as the sample grows", () => {
    expect(minimumDetectableEffect(900, 0.8)).toBeLessThan(minimumDetectableEffect(220, 0.8));
  });
});

describe("power CLI", () => {
  it("prints the MDE for task count, K and baseline", () => {
    const out: string[] = [];
    expect(main(["--tasks", "44", "--k", "5", "--baseline", "0.8"], (l) => out.push(l))).toBe(0);
    expect(out[0]).toMatch(/^Minimum detectable effect .*: 10\.\d points for 44 tasks × K=5/);
  });

  it("rejects nonsense", () => {
    const out: string[] = [];
    expect(main(["--baseline", "1.5"], (l) => out.push(l))).toBe(2);
    expect(out[0]).toMatch(/^usage:/);
  });
});
