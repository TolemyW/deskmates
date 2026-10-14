import { egressAllows } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import {
  loadBotFixture,
  loadPriceTableFixture,
  loadRunEventsFixture,
  loadWorkspaceFixture,
} from "./fixtures.js";

describe("fixtures", () => {
  it("workspace and bot agree on the workspace id; the allowlist admits the golden site", () => {
    const ws = loadWorkspaceFixture();
    const bot = loadBotFixture();
    expect(bot.workspaceId).toBe(ws.id);
    expect(ws.sandboxProvider).toBe("docker");
    expect(egressAllows("golden.test", ws.egressAllowlist)).toBe(true);
    expect(egressAllows("evil.test", ws.egressAllowlist)).toBe(false);
  });

  it("bot leaves the model to deployment configuration", () => {
    const bot = loadBotFixture();
    expect(bot.model).toBeUndefined();
    expect(bot.cheapModel).toBeUndefined();
  });

  it("price table rows are complete and positive", () => {
    const rows = loadPriceTableFixture();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) {
      expect(r.model).toMatch(/^fixture-model-/);
      for (const v of [r.inputPerM, r.outputPerM, r.cacheReadPerM, r.cacheCreatePerM]) {
        expect(v).toBeGreaterThan(0);
      }
    }
  });

  it("run events are one run with contiguous seq, sorted timestamps and no secrets", () => {
    const events = loadRunEventsFixture();
    const runIds = new Set(events.map((e) => e.runId));
    expect(runIds.size).toBe(1);
    events.forEach((e, i) => expect(e.seq).toBe(i + 1));
    for (let i = 1; i < events.length; i++) {
      expect((events[i]?.ts ?? "") >= (events[i - 1]?.ts ?? "")).toBe(true);
    }
    const kinds = new Set(events.map((e) => e.kind));
    for (const k of ["tool_call", "tool_result", "thinking", "screenshot", "log", "approval"]) {
      expect(kinds.has(k as (typeof events)[number]["kind"])).toBe(true);
    }
    const text = JSON.stringify(events);
    expect(text).not.toMatch(/gk_live_|ANTHROPIC_AUTH_TOKEN|gsid=/);
  });

  it("returns a fresh copy on every load", () => {
    const a = loadRunEventsFixture();
    a.pop();
    expect(loadRunEventsFixture().length).toBe(a.length + 1);
  });
});
