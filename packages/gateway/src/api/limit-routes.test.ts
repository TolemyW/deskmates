// T1: the workspace limits routes (ADR-0005 amendment 5 decisions 37, 39 and 41, ADR-0016
// amendment 2 decision 13). Validation, `off` needing a budget, the audit row and the view.

import type { WorkspaceLimitsView } from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "../test-support/harness.js";

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

const audits = () =>
  h.app.deskmates.ctx.db
    .prepare(
      "SELECT actor, before_json, after_json FROM audit_events WHERE action = 'workspace.limits_set' ORDER BY seq",
    )
    .all() as { actor: string; before_json: string; after_json: string }[];

describe("workspace limits routes", () => {
  it("shows today's defaults with their sources for a new workspace", async () => {
    const { workspace } = await h.seed();
    const res = await h.api<{ limits: WorkspaceLimitsView }>(
      "GET",
      `/api/workspaces/${workspace.id}/limits`,
    );
    expect(res.status).toBe(200);
    expect(res.json.limits).toMatchObject({
      workspaceId: workspace.id,
      settings: {},
      effective: {
        maxTurns: { value: 50, source: "gateway" },
        turnBudget: { value: 8, source: "default" },
        relayCountMax: { value: 5, source: "default" },
        continuationLimit: { value: 2, source: "default" },
        continuationWindowHours: { value: 24, source: "default" },
      },
      loopBreaker: { relayMax: 50, botMessages: 100, repeats: 3 },
      budgetBackstop: false,
    });
  });

  it("validates, stores and audits a change", async () => {
    const { workspace } = await h.seed();
    const path = `/api/workspaces/${workspace.id}/limits`;
    for (const body of [
      { turnBudget: 0 },
      { relayCountMax: 51 },
      { maxTurns: "lots" },
      { nope: 1 },
      { turnBudget: "off" },
    ]) {
      const res = await h.api<{ code: string }>("PUT", path, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(audits()).toHaveLength(0);
    const set = await h.api<{ limits: WorkspaceLimitsView }>("PUT", path, {
      turnBudget: 20,
      maxTurns: 120,
    });
    expect(set.status).toBe(200);
    expect(set.json.limits.settings).toEqual({ turnBudget: 20, maxTurns: 120 });
    expect(set.json.limits.effective.turnBudget).toEqual({ value: 20, source: "workspace" });
    const [row] = audits();
    expect(JSON.parse(row?.after_json ?? "")).toEqual({ turnBudget: 20, maxTurns: 120 });
    expect(row?.actor).toBe("web");
  });

  it("accepts off only with a monetary limit, and falls back when the limit is cleared", async () => {
    const { workspace } = await h.seed();
    const path = `/api/workspaces/${workspace.id}/limits`;
    await h.api("PUT", `/api/budgets/${workspace.id}`, { weeklyLimitUsd: 5 });
    const off = await h.api<{ limits: WorkspaceLimitsView }>("PUT", path, { relayCountMax: "off" });
    expect(off.status).toBe(200);
    expect(off.json.limits.effective.relayCountMax).toEqual({ value: null, source: "workspace" });
    await h.api("PUT", `/api/budgets/${workspace.id}`, { weeklyLimitUsd: null });
    const after = await h.api<{ limits: WorkspaceLimitsView }>("GET", path);
    expect(after.json.limits.settings).toEqual({ relayCountMax: "off" });
    expect(after.json.limits.effective.relayCountMax).toEqual({
      value: 5,
      source: "default_no_backstop",
    });
  });

  it("404s an unknown workspace", async () => {
    const res = await h.api("GET", "/api/workspaces/ws_missing/limits");
    expect(res.status).toBe(404);
  });
});
