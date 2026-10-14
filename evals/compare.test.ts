// T0: the paired verdict of measurement §4.3 on synthetic result files, one per verdict, plus
// the per-bucket rule, the fingerprint test, the cost interval and the CLI.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "./compare.js";
import { compareResults } from "./compare/compare-results.js";
import { fSurvival, normalQuantile, tQuantile } from "./compare/distributions.js";
import { pairedHotelling } from "./compare/hotelling.js";
import { renderCompareReport } from "./compare/report.js";
import { type DurationBucket, type ResultRow, parseResultFile } from "./compare/result-row.js";

const K = 5;

/** Deterministic noise in [0, 1). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

interface TaskSpec {
  taskId: string;
  bucket: DurationBucket;
  passes: number;
  steps?: number;
  cost?: number | null;
}

function rows(tasks: readonly TaskSpec[], seed = 1): ResultRow[] {
  const noise = rng(seed);
  return tasks.flatMap((t) =>
    Array.from({ length: K }, (_, i) => ({
      taskId: t.taskId,
      bucket: t.bucket,
      repeat: i + 1,
      success: i < t.passes,
      fingerprint: {
        steps: (t.steps ?? 10) + noise() * 4,
        outputTokens: 500 + noise() * 100,
        errors: noise() < 0.2 ? 1 : 0,
      },
      costUsd: t.cost === undefined ? 0.1 + noise() * 0.02 : t.cost,
    })),
  );
}

function tasks(
  n: number,
  bucket: (i: number) => DurationBucket,
  passes: (i: number) => number,
  extra: (i: number) => Partial<TaskSpec> = () => ({}),
): TaskSpec[] {
  return Array.from({ length: n }, (_, i) => ({
    taskId: `T${String(i).padStart(2, "0")}`,
    bucket: bucket(i),
    passes: passes(i),
    ...extra(i),
  }));
}

const shortOrMedium = (i: number): DurationBucket => (i % 3 === 0 ? "medium" : "short");

describe("distributions", () => {
  it("agrees with textbook values", () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5);
    expect(tQuantile(0.975, 10)).toBeCloseTo(2.228139, 5);
    expect(tQuantile(0.975, 43)).toBeCloseTo(2.016692, 5);
    // F(2, 10) upper 5% point is 4.1028.
    expect(fSurvival(4.102821, 2, 10)).toBeCloseTo(0.05, 5);
  });
});

describe("compareResults verdicts (measurement §4.3)", () => {
  it("better: the interval is above 0 and the estimate at least δ", () => {
    const base = tasks(40, shortOrMedium, (i) => 1 + (i % 3));
    const cand = tasks(40, shortOrMedium, (i) => 3 + (i % 3));
    const r = compareResults(rows(base, 1), rows(cand, 2));
    expect(r.overall.difference.estimate).toBeCloseTo(0.4, 10);
    expect(r.overall.difference.lower).toBeGreaterThan(0);
    expect(r.verdict).toBe("better");
    expect(r.passes).toBe(true);
    expect(r.buckets.map((b) => [b.scope, b.verdict])).toEqual([
      ["short", "better"],
      ["medium", "better"],
    ]);
  });

  it("worse: the interval is below 0 and the estimate at most −δ", () => {
    const base = tasks(40, shortOrMedium, (i) => 3 + (i % 3));
    const cand = tasks(40, shortOrMedium, (i) => 1 + (i % 3));
    const r = compareResults(rows(base, 1), rows(cand, 2));
    expect(r.verdict).toBe("worse");
    expect(r.passes).toBe(false);
  });

  it("no difference: the interval contains 0 and power at δ is at least 0.8", () => {
    const base = tasks(40, shortOrMedium, (i) => 2 + (i % 3));
    // Two tasks gain a run, two lose one: tiny, symmetric noise.
    const cand = tasks(40, shortOrMedium, (i) => 2 + (i % 3) + (i < 2 ? 1 : i < 4 ? -1 : 0));
    const r = compareResults(rows(base, 1), rows(cand, 2));
    expect(r.overall.difference.lower).toBeLessThanOrEqual(0);
    expect(r.overall.difference.upper).toBeGreaterThanOrEqual(0);
    expect(r.overall.difference.power).toBeGreaterThanOrEqual(0.8);
    expect(r.verdict).toBe("no difference");
    expect(r.passes).toBe(true);
  });

  it("inconclusive: too few tasks, too much spread", () => {
    const base = tasks(
      6,
      () => "short",
      () => 2,
    );
    const cand = tasks(
      6,
      () => "short",
      (i) => [4, 1, 5, 0, 3, 2][i] ?? 2,
    );
    const r = compareResults(rows(base, 1), rows(cand, 2));
    expect(r.overall.difference.estimate).toBeCloseTo(0.1, 10);
    expect(r.verdict).toBe("inconclusive");
  });

  it("does not pass when one bucket is worse, whatever the total says", () => {
    // Short gains a run on every task, medium loses two: the total is near zero.
    const base = tasks(
      44,
      (i) => (i < 30 ? "short" : "medium"),
      () => 2,
    );
    const cand = tasks(
      44,
      (i) => (i < 30 ? "short" : "medium"),
      (i) => (i < 30 ? 3 : 0),
    );
    const r = compareResults(rows(base, 1), rows(cand, 2));
    expect(r.overall.verdict).not.toBe("worse");
    expect(r.buckets.find((b) => b.scope === "medium")?.verdict).toBe("worse");
    expect(r.passes).toBe(false);
  });

  it("keeps long tasks out of the verdict and lists them per task", () => {
    const base = [
      ...tasks(
        20,
        () => "short",
        () => 3,
      ),
      { taskId: "L1", bucket: "long" as const, passes: 5 },
    ];
    const cand = [
      ...tasks(
        20,
        () => "short",
        () => 3,
      ),
      { taskId: "L1", bucket: "long" as const, passes: 0 },
    ];
    const r = compareResults(rows(base, 1), rows(cand, 1));
    expect(r.pairedTasks).toBe(20);
    expect(r.verdict).toBe("no difference");
    expect(r.longTasks).toEqual([{ taskId: "L1", baseline: "5/5", candidate: "0/5" }]);
  });

  it("rejects an explicit long-bucket regression despite gains in shorter campaigns", () => {
    const base = [
      ...tasks(
        40,
        () => "short",
        () => 3,
      ),
      ...tasks(
        8,
        () => "long",
        () => 5,
      ).map((t) => ({ ...t, taskId: `L${t.taskId}` })),
    ];
    const candidate = base.map((t) => ({ ...t, passes: t.bucket === "long" ? 0 : 4 }));
    const baselineRows = rows(base, 1);
    const candidateRows = rows(candidate, 2);
    expect(compareResults(baselineRows, candidateRows).passes).toBe(true);
    const report = compareResults(baselineRows, candidateRows, { includeLong: true });
    expect(report.includesLong).toBe(true);
    expect(report.pairedTasks).toBe(48);
    expect(report.overall.verdict).not.toBe("worse");
    expect(report.buckets.find((bucket) => bucket.scope === "long")?.verdict).toBe("worse");
    expect(report.passes).toBe(false);
    const text = renderCompareReport(report, { baseline: "off", candidate: "on" });
    expect(text).toContain("Long tasks (included in the verdict)");
    expect(text).not.toContain("Long-task regression is not measured");
    expect(text).not.toContain("smoke set");
  });

  it("keeps explicit long-bucket evidence inconclusive when there is only one campaign pair", () => {
    const base = rows([{ taskId: "L1", bucket: "long", passes: 5 }]);
    const candidate = rows([{ taskId: "L1", bucket: "long", passes: 0 }]);
    const report = compareResults(base, candidate, { includeLong: true });
    expect(report.pairedTasks).toBe(1);
    expect(report.overall.verdict).toBe("inconclusive");
    expect(report.buckets[0]?.scope).toBe("long");
    expect(report.buckets[0]?.difference.n).toBe(1);
  });

  it("pairs by task and lists tasks present on one side only", () => {
    const base = tasks(
      10,
      () => "short",
      () => 3,
    );
    const cand = tasks(
      12,
      () => "short",
      () => 3,
    ).slice(1);
    const r = compareResults(rows(base, 1), rows(cand, 1));
    expect(r.pairedTasks).toBe(9);
    expect(r.baselineOnly).toEqual(["T00"]);
    expect(r.candidateOnly).toEqual(["T10", "T11"]);
  });
});

describe("fingerprint and cost (measurement §3.5, §4.3 last paragraph)", () => {
  it("detects a moved fingerprint with the same pass rate, and a cheaper cost: 'cheaper'", () => {
    const base = tasks(
      40,
      shortOrMedium,
      () => 3,
      () => ({ steps: 10, cost: null }),
    );
    const cand = tasks(
      40,
      shortOrMedium,
      () => 3,
      () => ({ steps: 16, cost: null }),
    );
    const baseRows = rows(base, 1).map((r, i) => ({ ...r, costUsd: 0.2 + (i % 7) * 0.001 }));
    const candRows = rows(cand, 2).map((r, i) => ({ ...r, costUsd: 0.12 + (i % 5) * 0.001 }));
    const r = compareResults(baseRows, candRows);
    expect(r.verdict).toBe("no difference");
    expect(r.fingerprint.computable).toBe(true);
    expect(r.fingerprint.movedAny).toBe(true);
    expect(r.cost?.relative.estimate).toBeLessThan(-0.15);
    expect(r.cost?.verdict).toBe("better");
    expect(r.note).toBe("cheaper");
  });

  it("does not flag a fingerprint drawn from the same distribution", () => {
    const base = tasks(40, shortOrMedium, () => 3);
    const r = compareResults(rows(base, 11), rows(base, 12));
    expect(r.fingerprint.movedAny).toBe(false);
    expect(r.note).toBeUndefined();
  });

  it("calls a moved fingerprint with dearer runs behavioral drift", () => {
    const base = tasks(
      40,
      shortOrMedium,
      () => 3,
      () => ({ steps: 10, cost: 0.1 }),
    );
    const cand = tasks(
      40,
      shortOrMedium,
      () => 3,
      () => ({ steps: 16, cost: 0.2 }),
    );
    const r = compareResults(rows(base, 1), rows(cand, 2));
    expect(r.cost?.verdict).toBe("worse");
    expect(r.note).toBe("behavioral drift, a human must read the trajectories");
  });

  it("leaves cost unknown when no run has one", () => {
    const base = tasks(
      10,
      () => "short",
      () => 3,
      () => ({ cost: null }),
    );
    expect(compareResults(rows(base, 1), rows(base, 2)).cost).toBeUndefined();
  });

  it("paired Hotelling needs more tasks than varying dimensions", () => {
    const r = pairedHotelling([
      { a: 1, b: 2 },
      { a: 2, b: 1 },
    ]);
    expect(r.computable).toBe(false);
  });
});

describe("compare CLI", () => {
  it("includes the explicit long bucket in the CLI verdict and rejects a false flag value", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deskmates-long-compare-"));
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    const base = tasks(
      8,
      () => "long",
      () => 5,
    );
    const candidate = base.map((t) => ({ ...t, passes: 0 }));
    writeFileSync(
      a,
      rows(base)
        .map((r) => JSON.stringify(r))
        .join("\n"),
    );
    writeFileSync(
      b,
      rows(candidate)
        .map((r) => JSON.stringify(r))
        .join("\n"),
    );
    const out: string[] = [];
    expect(await main([a, b, "--include-long", "--json"], (line) => out.push(line))).toBe(1);
    expect(JSON.parse(out[0] ?? "{}").includesLong).toBe(true);
    expect(await main([a, b, "--include-long=false"], () => {})).toBe(2);
  });

  it("prints the MDE first and the long-task caveat, and exits 1 when a scope is worse", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deskmates-compare-"));
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    const toJsonl = (r: ResultRow[]) => `${r.map((x) => JSON.stringify(x)).join("\n")}\n`;
    writeFileSync(
      a,
      toJsonl(
        rows(
          tasks(40, shortOrMedium, (i) => 3 + (i % 3)),
          1,
        ),
      ),
    );
    writeFileSync(
      b,
      toJsonl(
        rows(
          tasks(40, shortOrMedium, (i) => 1 + (i % 3)),
          2,
        ),
      ),
    );
    const out: string[] = [];
    expect(await main([a, b, "--report", join(dir, "r.md")], (l) => out.push(l))).toBe(1);
    const text = out.join("\n");
    expect(text.split("\n")[0]).toMatch(/^Minimum detectable effect/);
    expect(text).toContain("Long-task regression is not measured");
    expect(text).toContain("| all | 40 |");
    expect(text).toContain("Verdict: worse.");
    expect(await main([b, a], () => {})).toBe(0);
    expect(await main([a], () => {})).toBe(2);
  });

  it("rejects a malformed results line with its line number", () => {
    expect(() =>
      parseResultFile(
        '{"taskId":"S01","bucket":"short","success":true}\n{"taskId":"S02"}',
        "x.jsonl",
      ),
    ).toThrow("x.jsonl:2");
  });
});
