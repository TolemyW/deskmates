// T0 (ADR-0048 decision 13, owner ruling 8): the prepared desktop visual task is complete and
// zero-cost, names no model id, and its oracles judge observations independently of the model's
// own reply. Prepared, not run.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type DesktopTaskObservation, judgeDesktopTask } from "./oracle.js";

const task = JSON.parse(
  readFileSync(new URL("./visual-save-task.json", import.meta.url), "utf8"),
) as Record<string, unknown> & {
  cost: { priceUsdPerMillionTokens: Record<string, number>; paidModelsAllowed: boolean };
  oracles: { id: string; kind: string }[];
};

const good: DesktopTaskObservation = {
  code: "K7RT4X",
  savedFile: new TextEncoder().encode("K7RT4X\n"),
  window: { title: "Deskmates desktop fixture", status: "Saved" },
  events: [
    { kind: "tool_call", payload: { toolName: "mcp__desktop__js", desktopEffects: ["capture"] } },
    { kind: "tool_call", payload: { toolName: "mcp__desktop__js", desktopEffects: ["input"] } },
  ],
  usage: [{ model: "local-vision", inputTokens: 1200, outputTokens: 80, costUsd: 0 }],
};

describe("the prepared desktop visual task", () => {
  it("is prepared, zero-cost, allows no paid model and names no model id", () => {
    expect(task.status).toBe("prepared");
    expect(task.decision).toBe("ADR-0048 decision 13");
    expect(Object.values(task.cost.priceUsdPerMillionTokens).every((p) => p === 0)).toBe(true);
    expect(task.cost.paidModelsAllowed).toBe(false);
    const text = JSON.stringify(task);
    expect(text).not.toMatch(/claude-|gpt-|glm|deepseek|qwen|sonnet|opus|haiku/i);
    expect(text).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
  });

  it("has two independent oracles and two validity conditions", () => {
    expect(task.oracles.filter((o) => o.kind === "independent").map((o) => o.id)).toEqual([
      "file-bytes",
      "saved-state",
    ]);
    expect(task.oracles.filter((o) => o.kind === "ledger").map((o) => o.id)).toEqual([
      "used-screenshot",
      "accounting",
    ]);
  });
});

describe("judgeDesktopTask", () => {
  it("passes the exact bytes, saved state, a capture before input and a known zero price", () => {
    expect(judgeDesktopTask(good)).toEqual({ success: true, valid: true, failed: [] });
  });

  it("fails a wrong byte or an unsaved window, whatever the model replied", () => {
    expect(
      judgeDesktopTask({ ...good, savedFile: new TextEncoder().encode("K7RT4X") }).success,
    ).toBe(false);
    expect(
      judgeDesktopTask({ ...good, window: { title: "*Deskmates desktop fixture", status: "" } })
        .failed,
    ).toEqual(["saved-state"]);
  });

  it("excludes a run that typed before any screenshot or has unknown or paid cost", () => {
    const blind = {
      ...good,
      events: [...(good.events.slice(1) ?? []), ...(good.events.slice(0, 1) ?? [])],
    };
    expect(judgeDesktopTask(blind)).toMatchObject({ valid: false, failed: ["used-screenshot"] });
    expect(
      judgeDesktopTask({ ...good, usage: [{ model: "m", inputTokens: 1, outputTokens: 1 }] }).valid,
    ).toBe(false);
    expect(
      judgeDesktopTask({
        ...good,
        usage: [{ model: "m", inputTokens: 1, outputTokens: 1, costUsd: 0.01 }],
      }).valid,
    ).toBe(false);
    expect(
      judgeDesktopTask({
        ...good,
        events: [...good.events, { kind: "pricing_missing", payload: {} }],
      }).valid,
    ).toBe(false);
  });
});
