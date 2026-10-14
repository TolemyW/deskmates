import type { RunId } from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGateway } from "../index.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { testConfig } from "../test-support/harness.js";

let app: ReturnType<typeof buildGateway>;

beforeEach(async () => {
  app = buildGateway(testConfig({ browserRetainedTabs: 0 }), new FakeProvider(), {
    surface: "combined-test",
    startCron: false,
  });
  app.deskmates.scheduler.stop();
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

function seed() {
  const { ctx, lifecycle } = app.deskmates;
  const workspace = ctx.workspaces.create({ name: "retention", sandboxProvider: "docker" });
  const bot = ctx.bots.create({ workspaceId: workspace.id, name: "alice", role: "tester" });
  const thread = ctx.threads.create({ workspaceId: workspace.id, botIds: [bot.id] });
  const queued = ctx.router.postHuman({ threadId: thread.id, body: "browse" }).runs[0];
  if (!queued) throw new Error("no current run");
  const current = lifecycle.start(queued);
  const completed = ctx.runs.create({
    botId: bot.id,
    lane: "background",
    triggerKind: "webhook",
    triggerRef: "completed",
    triggerPayload: {},
    config: ctx.runConfig(),
  });
  ctx.events.append({
    runId: completed.id,
    kind: "log",
    payload: { source: "browser_lock", op: "tab_acquired", tabId: "target-completed" },
  });
  ctx.db
    .prepare("UPDATE runs SET status = 'succeeded', finished_at = ? WHERE id = ?")
    .run(new Date().toISOString(), completed.id);
  return { current, completed };
}

function request(
  run: { run: { id: RunId }; token: string },
  method: "GET" | "POST",
  suffix = "",
  payload?: Record<string, unknown>,
) {
  return app.inject({
    method,
    url: `/internal/runs/${run.run.id}/browser-retention${suffix}`,
    headers: { authorization: `Bearer ${run.token}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

describe("browser retention API", () => {
  it("binds a plan to the authenticated run and audits only planned closes", async () => {
    const { ctx } = app.deskmates;
    const { current } = seed();
    const get = await request(current, "GET");
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({ targetIds: ["target-completed"] });

    // Closing temporarily acquires the candidate target. The issued plan remains authoritative.
    await app.inject({
      method: "POST",
      url: `/internal/runs/${current.run.id}/browser-lock`,
      headers: { authorization: `Bearer ${current.token}` },
      payload: { op: "acquire", tabId: "target-completed" },
    });
    const closed = await request(current, "POST", "/closed", {
      targetIds: ["target-completed"],
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toEqual({ recorded: 1 });
    expect(
      ctx.events
        .list(current.run.id)
        .filter((event) => event.payload.source === "browser_retention")
        .map((event) => event.payload.phase),
    ).toEqual(["planned", "closed"]);

    expect(
      (await request(current, "POST", "/closed", { targetIds: ["target-completed"] })).statusCode,
    ).toBe(400);
    expect(
      (await request(current, "POST", "/closed", { targetIds: ["arbitrary"] })).statusCode,
    ).toBe(400);
  });

  it("requires the matching run token and an issued plan", async () => {
    const { current } = seed();
    const missing = await app.inject({
      method: "GET",
      url: `/internal/runs/${current.run.id}/browser-retention`,
    });
    expect(missing.statusCode).toBe(401);
    expect(
      (await request(current, "POST", "/closed", { targetIds: ["target-completed"] })).statusCode,
    ).toBe(400);
  });
});
