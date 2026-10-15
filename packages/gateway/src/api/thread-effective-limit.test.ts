// T1: the thread detail carries the turn budget the router actually enforces (ADR-0005
// amendment 5 decisions 38, 39 and 42): the workspace setting, else off (`null`); the thread row's
// `turn_budget` only under "require a budget for unlimited limits" without a budget. The chat info
// panel shows this value, not the stored row.

import type { EffectiveLimit, Thread } from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "../test-support/harness.js";

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

type Detail = { thread: Thread; effectiveTurnBudget: EffectiveLimit };

describe("thread detail effective turn budget", () => {
  it("is off until the workspace sets one, then the workspace's", async () => {
    const { workspace, thread } = await h.seed();
    const before = await h.api<Detail>("GET", `/api/threads/${thread.id}`);
    expect(before.status).toBe(200);
    expect(before.json.effectiveTurnBudget).toEqual({ value: null, source: "default" });

    await h.api("PUT", `/api/workspaces/${workspace.id}/limits`, { turnBudget: 20 });
    const after = await h.api<Detail>("GET", `/api/threads/${thread.id}`);
    expect(after.json.thread.turnBudget).toBe(thread.turnBudget);
    expect(after.json.effectiveTurnBudget).toEqual({ value: 20, source: "workspace" });
  });

  it("is the thread row's value when the workspace requires a budget and has none", async () => {
    const { workspace, thread } = await h.seed();
    await h.api("PUT", `/api/workspaces/${workspace.id}/limits`, { requireBudgetForOff: true });
    const res = await h.api<Detail>("GET", `/api/threads/${thread.id}`);
    expect(res.json.effectiveTurnBudget).toEqual({
      value: thread.turnBudget,
      source: "default_no_backstop",
    });
  });

  it("is null when the workspace turned the turn budget off", async () => {
    const { workspace, thread } = await h.seed();
    const off = await h.api("PUT", `/api/workspaces/${workspace.id}/limits`, { turnBudget: "off" });
    expect(off.status).toBe(200);
    const res = await h.api<Detail>("GET", `/api/threads/${thread.id}`);
    expect(res.json.effectiveTurnBudget).toEqual({ value: null, source: "workspace" });
  });
});
