// T1: `GET /api/runtime`, the drain signal a release script polls before it stops the Gateway.
// Only runs whose sidecar is executing count; queued and parked runs survive a restart intact.

import type { RunId, RunStatus, RuntimeStatus } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "../test-support/harness.js";

let h: Harness;

afterEach(async () => {
  await h.close();
});

describe("GET /api/runtime", () => {
  it("reports zero active runs on an idle Gateway", async () => {
    h = await startHarness();
    const res = await h.api<RuntimeStatus>("GET", "/api/runtime");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      activeRuns: 0,
      activeRunIds: [],
      draining: false,
      drainParkedRunIds: [],
      restartBreaker: { tripped: false, limit: 3, windowMinutes: 10, heldRunIds: [] },
    });
  });

  it("counts running and live-approval runs, not queued, parked or finished ones", async () => {
    h = await startHarness();
    const { bot } = await h.seed();
    h.app.deskmates.scheduler.stop();
    const ctx = h.app.deskmates.ctx;
    const runIn = (...path: RunStatus[]): RunId => {
      const run = ctx.runs.create({
        botId: bot.id,
        lane: "background",
        triggerKind: "webhook",
        triggerRef: `runtime-${path.join("-")}`,
        triggerPayload: { body: "x" },
        config: ctx.runConfig(),
      });
      for (const status of path) ctx.runs.transition(run.id, status);
      return run.id;
    };
    const running = runIn("running");
    const live = runIn("running", "waiting_approval_live");
    runIn(); // queued: no sidecar yet
    runIn("running", "waiting_approval"); // parked on a deferred approval
    runIn("running", "waiting_browser"); // parked behind a human takeover
    runIn("running", "succeeded");
    runIn("running", "failed");

    const res = await h.api<RuntimeStatus>("GET", "/api/runtime");
    expect(res.status).toBe(200);
    expect(res.json.activeRuns).toBe(2);
    expect([...res.json.activeRunIds].sort()).toEqual([running, live].sort());
  });

  it("requires the operator credential", async () => {
    h = await startHarness();
    const anonymous = await fetch(`${h.baseUrl}/api/runtime`);
    expect(anonymous.status).toBe(401);
    const wrong = await fetch(`${h.baseUrl}/api/runtime`, {
      headers: { authorization: "Bearer not-the-operator-token" },
    });
    expect(wrong.status).toBe(401);
  });
});
