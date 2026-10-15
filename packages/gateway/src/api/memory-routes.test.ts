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
// database write that never runs in the container. ADR-0043 decision 3: a live or parked run of
// the bot no longer refuses it; the edit is saved, says it applies from the next run, and is a
// numbered version with an audit row like a SOUL edit.
it("stores a memory edit canonically without the container, saved even while the bot is busy", async () => {
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
  const patch = (body: string, expectedVersion: string) =>
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
  const first = "Do not execute $(anything).";
  const busy = await patch(first, version(""));
  expect(busy.statusCode).toBe(200);
  expect(busy.json()).toEqual({
    memory: { body: first, version: version(first) },
    appliesFromNextRun: true,
  });
  ctx.db.prepare("UPDATE runs SET status='waiting_approval' WHERE id=?").run(own.id);
  const second = `${first}\nPrefer short answers.`;
  const parked = await patch(second, version(first));
  expect(parked.statusCode).toBe(200);
  expect(parked.json().appliesFromNextRun).toBe(true);
  ctx.db.prepare("UPDATE runs SET status='cancelled' WHERE id=?").run(own.id);
  expect((await patch("stale", "a".repeat(64))).statusCode).toBe(409);
  const idle = await patch(first, version(second));
  expect(idle.statusCode).toBe(200);
  expect(idle.json().appliesFromNextRun).toBe(false);

  expect(ctx.bots.legacyMemory(bot.id)).toEqual({ body: first, version: version(first) });
  expect(ctx.bots.versions.list(bot.id, "memory").map((v) => [v.version, v.bytes])).toEqual([
    [3, Buffer.byteLength(first)],
    [2, Buffer.byteLength(second)],
    [1, Buffer.byteLength(first)],
  ]);
  const audits = ctx.audit
    .list({ targetId: bot.id })
    .filter((event) => event.action === "bot.update")
    .reverse();
  expect(audits.map((event) => event.after)).toEqual([
    { memoryVersion: version(first), memoryRevision: 1 },
    { memoryVersion: version(second), memoryRevision: 2 },
    { memoryVersion: version(first), memoryRevision: 3 },
  ]);
  // The audit keeps hashes and numbers, never the text.
  expect(JSON.stringify(audits)).not.toContain("execute");
  expect(ctx.runs.mustGet(peerRun.id).status).toBe("running");
  expect(exec).not.toHaveBeenCalled();
});
