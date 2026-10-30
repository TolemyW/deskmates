import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseMission, remainingMs, verdict } from "./mission.js";

const singleText = readFileSync(new URL("./missions/l01-single.json", import.meta.url), "utf8");

describe("long-horizon mission declaration", () => {
  it("validates both frozen task shapes", () => {
    expect(parseMission(singleText).phases).toHaveLength(1);
    const multi = parseMission(
      readFileSync(new URL("./missions/lh01-overdue-sweep.json", import.meta.url), "utf8"),
    );
    expect(multi.phases.filter((p) => p.inject)).toHaveLength(2);
    expect(multi.phases.some((p) => p.trigger?.kind === "cron")).toBe(true);
  });
  it.each([
    [
      "budget",
      (m: ReturnType<typeof parseMission>) => {
        m.budgets.maxTurns = 0;
      },
    ],
    [
      "duplicate phase",
      (m: ReturnType<typeof parseMission>) => {
        m.phases.push(structuredClone(m.phases[0]) as (typeof m.phases)[number]);
      },
    ],
    [
      "unbounded mission",
      (m: ReturnType<typeof parseMission>) => {
        m.budgets.missionWallSeconds = Number.POSITIVE_INFINITY;
      },
    ],
    [
      "missing collateral oracle",
      (m: ReturnType<typeof parseMission>) => {
        m.final = m.final.filter((o) => o.type !== "no_unexpected_changes");
      },
    ],
    [
      "final self report",
      (m: ReturnType<typeof parseMission>) => {
        m.final.push({ name: "claim", type: "answer", value: "done" });
      },
    ],
    [
      "ambiguous trigger",
      (m: ReturnType<typeof parseMission>) => {
        const p = m.phases[0];
        if (p) p.inject = "gateway_restart";
      },
    ],
    [
      "unsafe file",
      (m: ReturnType<typeof parseMission>) => {
        m.phases[0]?.checkpoints.push({
          name: "bad",
          type: "file_regex_count",
          path: "/work/../etc/passwd",
          regex: ".",
          op: "eq",
          value: 1,
        });
      },
    ],
    [
      "missing cron entry",
      (m: ReturnType<typeof parseMission>) => {
        const p = m.phases[0];
        if (p) p.trigger = { kind: "cron", entry: 0, at: "2026-10-19T03:00:00Z" };
      },
    ],
  ] as const)("rejects %s before any stack starts", (_name, mutate) => {
    const mission = parseMission(singleText);
    mutate(mission);
    expect(() => parseMission(JSON.stringify(mission))).toThrow();
  });
  it("does not turn missing or empty evidence into a passing verdict", () => {
    expect(verdict([])).toBe("unknown");
    expect(verdict([{ status: "pass" }, { status: "unknown" }])).toBe("unknown");
    expect(verdict([{ status: "fail" }, { status: "unknown" }])).toBe("fail");
  });
  it("clamps every phase, hold and resume to one absolute deadline", () => {
    expect(remainingMs(1000, 800, 500)).toBe(200);
    expect(remainingMs(1000, 1100, 500)).toBe(0);
    expect(remainingMs(1000, 200, 100)).toBe(100);
  });
});
