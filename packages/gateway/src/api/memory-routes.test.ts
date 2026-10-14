import { createHash } from "node:crypto";
import type { BotId } from "@deskmates/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { buildGateway } from "../index.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { TEST_OPERATOR_TOKEN, testConfig } from "../test-support/harness.js";

const apps: ReturnType<typeof buildGateway>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.deskmates.scheduler.drain();
    await app.close();
  }
});
// MEMORY.md is canonical Gateway configuration (migration 0019): an edit is a version-checked
// database write that never runs in the container, so it no longer holds the workspace's queued
// starts. Only this bot's own live or parked run blocks it; other bots need not be idle.
it("stores a memory edit canonically without the container, blocked only by the bot's own work", async () => {
  const provider = new FakeProvider();
  const app = buildGateway(testConfig(), provider, { surface: "combined-test", startCron: false });
  apps.push(app);
  await app.ready();
  app.deskmates.scheduler.stop();
  const ctx = app.deskmates.ctx;
  const workspace = ctx.workspaces.create({ name: "memory", sandboxProvider: "docker" });
  const bot = ctx.bots.create({ name: "writer", role: "test", workspaceId: workspace.id });
  const peer = ctx.bots.create({ name: "peer", role: "test", workspaceId: workspace.id });
  await ctx.sandboxes.ensure(workspace);
  const exec = vi.spyOn(provider, "exec");
  const version = (text: string) => createHash("sha256").update(text).digest("hex");
  const body = "Do not execute $(anything).";
  const patch = (expectedVersion: string) =>
    app.inject({
      method: "PATCH",
      url: `/api/bots/${bot.id}/memory`,
      headers: { authorization: `Bearer ${TEST_OPERATOR_TOKEN}` },
      payload: { body, expectedVersion },
    });
  const runIn = (botId: BotId, status: string) => {
    const run = ctx.runs.create({
      botId,
      lane: "background",
      triggerKind: "webhook",
      triggerRef: `${status}-during-edit`,
      triggerPayload: { body: "task" },
      config: ctx.runConfig(),
    });
    ctx.db.prepare("UPDATE runs SET status=? WHERE id=?").run(status, run.id);
    return run;
  };

  const peerRun = runIn(peer.id, "running");
  const own = runIn(bot.id, "running");
  const busy = await patch(version(""));
  expect(busy.statusCode).toBe(409);
  expect(busy.json().code).toBe("lane_busy");
  ctx.db.prepare("UPDATE runs SET status='waiting_approval' WHERE id=?").run(own.id);
  const parked = await patch(version(""));
  expect(parked.statusCode).toBe(409);
  expect(parked.json().code).toBe("invalid_transition");
  ctx.db.prepare("UPDATE runs SET status='cancelled' WHERE id=?").run(own.id);
  expect((await patch("a".repeat(64))).statusCode).toBe(409);
  expect(ctx.bots.legacyMemory(bot.id)).toEqual({ body: "", version: version("") });

  const saved = await patch(version(""));
  expect(saved.statusCode).toBe(200);
  expect(saved.json().memory).toEqual({ body, version: version(body) });
  expect(ctx.bots.legacyMemory(bot.id)).toEqual({ body, version: version(body) });
  expect(ctx.runs.mustGet(peerRun.id).status).toBe("running");
  expect(exec).not.toHaveBeenCalled();
});
