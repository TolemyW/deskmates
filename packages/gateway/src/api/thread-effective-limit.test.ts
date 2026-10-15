// T1: the thread detail carries the turn budget the router actually enforces (ADR-0005
// amendment 5 decision 38): the workspace setting, else the thread row's `turn_budget`; `off`
// is `null`. The chat info panel shows this value, not the stored row.

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
  it("is the thread row's value until the workspace sets one, then the workspace's", async () => {
    const { workspace, thread } = await h.seed();
    const before = await h.api<Detail>("GET", `/api/threads/${thread.id}`);
    expect(before.status).toBe(200);
    expect(before.json.effectiveTurnBudget).toEqual({
      value: thread.turnBudget,
      source: "thread",
    });

    await h.api("PUT", `/api/workspaces/${workspace.id}/limits`, { turnBudget: 20 });
    const after = await h.api<Detail>("GET", `/api/threads/${thread.id}`);
    expect(after.json.thread.turnBudget).toBe(thread.turnBudget);
    expect(after.json.effectiveTurnBudget).toEqual({ value: 20, source: "workspace" });
  });

  it("is null when the workspace turned the turn budget off", async () => {
    const { workspace, thread } = await h.seed();
    await h.api("PUT", `/api/budgets/${workspace.id}`, { weeklyLimitUsd: 5 });
    const off = await h.api("PUT", `/api/workspaces/${workspace.id}/limits`, { turnBudget: "off" });
    expect(off.status).toBe(200);
    const res = await h.api<Detail>("GET", `/api/threads/${thread.id}`);
    expect(res.json.effectiveTurnBudget).toEqual({ value: null, source: "workspace" });
  });
});
