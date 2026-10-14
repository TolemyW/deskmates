// T1: `GET /api/capacity?workspaceId=` (issue #16). Per bot, which lanes are free and how many
// runs wait or are parked on each; per workspace, who holds the browser lock and whether the
// container is running. Read from the runs and lock tables; another tenant's workspace is the
// guard's uniform 404.

import {
  type BotId,
  CSRF_HEADER,
  type CapacityResponse,
  type RunLane,
  type RunStatus,
  type WorkspaceId,
} from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunRecord } from "../ledger/runs.js";
import { type Harness, startHarness } from "../test-support/harness.js";
import { seedTenant } from "../test-support/tenants.js";

const SESSION = "__Host-deskmates-session";
const HOST = "gw.test";

let h: Harness;

beforeEach(async () => {
  h = await startHarness({
    secretsKey: Buffer.alloc(32, 7).toString("base64"),
    auth: { argon2: { memoryKiB: 1024, iterations: 1, parallelism: 1 }, liveSweepMs: 0 },
  });
  // Runs are put into each state by hand; a scheduling pass would start the queued ones.
  h.app.deskmates.scheduler.stop();
});

afterEach(async () => {
  await h.close();
});

/** A run of `botId` on `lane`, moved through the state machine to `status`. */
function runIn(botId: BotId, lane: RunLane, status: RunStatus): RunRecord {
  const { ctx } = h.app.deskmates;
  const run = ctx.runs.create({
    botId,
    lane,
    triggerKind: "webhook",
    triggerRef: `cap-${status}`,
    triggerPayload: { body: "x" },
    config: ctx.runConfig(),
  });
  const path: Partial<Record<RunStatus, RunStatus[]>> = {
    queued: [],
    running: ["running"],
    waiting_approval_live: ["running", "waiting_approval_live"],
    waiting_approval: ["running", "waiting_approval"],
    waiting_continuation: ["running", "waiting_continuation"],
    succeeded: ["running", "succeeded"],
  };
  let current = run;
  for (const step of path[status] ?? []) current = ctx.runs.transition(run.id, step);
  return current;
}

describe("GET /api/capacity", () => {
  it("reports free lanes, queue depth and parked runs per bot", async () => {
    const { workspace, bot } = await h.seed();
    const empty = await h.api<CapacityResponse>("GET", `/api/capacity?workspaceId=${workspace.id}`);
    expect(empty.status).toBe(200);
    expect(empty.json.capacity).toEqual({
      workspaceId: workspace.id,
      containerRunning: false,
      browserLock: null,
      sidecars: { active: 0 },
      bots: [
        {
          botId: bot.id,
          name: bot.name,
          lanes: {
            interactive: { free: true, queued: 0, parked: 0 },
            background: { free: true, queued: 0, parked: 0 },
          },
        },
      ],
    });

    const running = runIn(bot.id, "interactive", "running");
    runIn(bot.id, "interactive", "queued");
    runIn(bot.id, "interactive", "queued");
    runIn(bot.id, "interactive", "waiting_approval");
    runIn(bot.id, "background", "waiting_continuation");
    runIn(bot.id, "background", "queued");
    runIn(bot.id, "background", "succeeded");
    const busy = await h.api<CapacityResponse>("GET", `/api/capacity?workspaceId=${workspace.id}`);
    expect(busy.json.capacity.bots[0]?.lanes).toEqual({
      interactive: { free: false, activeRunId: running.id, queued: 2, parked: 1 },
      background: { free: true, queued: 1, parked: 1 },
    });
  });

  it("counts a live approval wait as holding the lane", async () => {
    const { workspace, bot } = await h.seed();
    const live = runIn(bot.id, "background", "waiting_approval_live");
    const res = await h.api<CapacityResponse>("GET", `/api/capacity?workspaceId=${workspace.id}`);
    expect(res.json.capacity.bots[0]?.lanes.background).toEqual({
      free: false,
      activeRunId: live.id,
      queued: 0,
      parked: 0,
    });
  });

  it("names the browser-lock holder: the runs holding tabs, or a human during takeover", async () => {
    const { workspace, bot } = await h.seed();
    const { ctx } = h.app.deskmates;
    const workspaceId = workspace.id as WorkspaceId;
    const run = runIn(bot.id, "interactive", "running");
    ctx.locks.handle(workspaceId, {
      type: "browser_lock",
      op: "acquire",
      runId: run.id,
      tabId: "tab-1",
    });
    const held = await h.api<CapacityResponse>("GET", `/api/capacity?workspaceId=${workspaceId}`);
    expect(held.json.capacity.browserLock).toEqual({ kind: "run", runIds: [run.id] });

    const taken = await h.api("POST", `/api/workspaces/${workspaceId}/takeover`, {});
    expect(taken.status).toBe(200);
    const human = await h.api<CapacityResponse>("GET", `/api/capacity?workspaceId=${workspaceId}`);
    expect(human.json.capacity.browserLock).toEqual({ kind: "human" });

    await h.api("POST", `/api/workspaces/${workspaceId}/handback`, {});
    ctx.locks.releaseForRun(run.id);
    const free = await h.api<CapacityResponse>("GET", `/api/capacity?workspaceId=${workspaceId}`);
    expect(free.json.capacity.browserLock).toBeNull();
  });

  it("says whether the workspace container is running, without starting one", async () => {
    const { workspace } = await h.seed();
    const workspaceId = workspace.id as WorkspaceId;
    const before = await h.api<CapacityResponse>("GET", `/api/capacity?workspaceId=${workspaceId}`);
    expect(before.json.capacity.containerRunning).toBe(false);
    expect(h.provider.created).toHaveLength(0);
    h.provider.existing.set(workspaceId, {
      workspaceId,
      providerRef: `fake-${workspaceId}`,
      sidecarAddress: "fake://sidecar",
    });
    const after = await h.api<CapacityResponse>("GET", `/api/capacity?workspaceId=${workspaceId}`);
    expect(after.json.capacity.containerRunning).toBe(true);
  });

  it("requires a workspace id", async () => {
    const res = await h.api<{ code: string }>("GET", "/api/capacity");
    expect(res.status).toBe(400);
    expect(res.json.code).toBe("validation");
  });

  it("answers another tenant's workspace with the uniform 404", async () => {
    const { ctx } = h.app.deskmates;
    const A = await seedTenant(ctx, "A");
    const B = await seedTenant(ctx, "B");
    const as = (who: typeof A, workspaceId: string) =>
      h.app.inject({
        method: "GET",
        url: `/api/capacity?workspaceId=${workspaceId}`,
        headers: {
          cookie: `${SESSION}=${who.token}`,
          host: HOST,
          origin: `http://${HOST}`,
          [CSRF_HEADER]: who.csrf,
        },
      });
    const foreign = await as(B, A.ids.workspace);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toEqual({ code: "not_found", message: "Not found", details: {} });
    expect(foreign.body).not.toContain(A.ids.bot);
    const own = await as(A, A.ids.workspace);
    expect(own.statusCode).toBe(200);
    const capacity = (own.json() as CapacityResponse).capacity;
    expect(capacity.bots.map((b) => b.botId)).toEqual([A.ids.bot]);
    // The fixture's run is queued on the interactive lane.
    expect(capacity.bots[0]?.lanes.interactive).toEqual({ free: true, queued: 1, parked: 0 });
  });
});
