import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { buildGateway } from "../index.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { TEST_OPERATOR_TOKEN, testConfig } from "../test-support/harness.js";

const apps: ReturnType<typeof buildGateway>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
const version = (body: string) => createHash("sha256").update(body).digest("hex");

it("versions SOUL, invalidates sessions, and applies a gated learned item as a memory entry", async () => {
  const provider = new FakeProvider();
  const app = buildGateway(testConfig(), provider, {
    surface: "combined-test",
    startCron: false,
  });
  apps.push(app);
  await app.ready();
  app.deskmates.scheduler.stop();
  const ctx = app.deskmates.ctx;
  const workspace = ctx.workspaces.create({ name: "governance", sandboxProvider: "docker" });
  const bot = ctx.bots.create({ name: "writer", role: "test", workspaceId: workspace.id });
  const thread = ctx.threads.create({ workspaceId: workspace.id, botIds: [bot.id] });
  ctx.sessions.set(bot.id, thread.id, "session-before-soul-change");
  const run = ctx.runs.create({
    botId: bot.id,
    lane: "background",
    triggerKind: "webhook",
    triggerRef: "suggestion-source",
    triggerPayload: {},
    config: ctx.runConfig(),
  });
  ctx.db.prepare("UPDATE runs SET status='succeeded' WHERE id=?").run(run.id);
  ctx.memory.confirmations.gate({
    workspaceId: workspace.id,
    runId: run.id,
    botId: bot.id,
    ordinal: 0,
    body: "Always check the refund queue.",
    proposedScope: "bot",
    authority: "procedure",
    trust: "untrusted",
    sourceKind: "webhook",
    reasons: ["imperative"],
  });
  await ctx.sandboxes.ensure(workspace);

  const files = new Map([
    ["MEMORY.md", ""],
    ["SOUL.md", "You are a writer."],
  ]);
  const writes: string[] = [];
  vi.spyOn(provider, "exec").mockImplementation(async (_handle, request) => {
    const input = JSON.parse(String(request.stdin)) as {
      fileName: "MEMORY.md" | "SOUL.md";
      op: "read" | "write";
      body?: string;
      expectedVersion?: string;
    };
    const current = files.get(input.fileName) ?? "";
    if (input.op === "write") {
      if (input.expectedVersion !== version(current))
        return {
          exitCode: 1,
          stdout: JSON.stringify({ error: "changed" }),
          stderr: "",
          timedOut: false,
        };
      files.set(input.fileName, input.body ?? "");
      writes.push(input.fileName);
    }
    const body = files.get(input.fileName) ?? "";
    return {
      exitCode: 0,
      stdout: JSON.stringify({ body, version: version(body) }),
      stderr: "",
      timedOut: false,
    };
  });
  const headers = { authorization: `Bearer ${TEST_OPERATOR_TOKEN}` };

  const soul = await app.inject({ method: "GET", url: `/api/bots/${bot.id}/soul`, headers });
  const soulVersion = soul.json().soul.version;
  const parked = ctx.runs.create({
    botId: bot.id,
    threadId: thread.id,
    lane: "interactive",
    triggerKind: "thread_message",
    triggerRef: "parked-before-soul",
    triggerPayload: {},
    config: ctx.runConfig(),
  });
  ctx.db.prepare("UPDATE runs SET status='waiting_approval' WHERE id=?").run(parked.id);
  expect(
    (
      await app.inject({
        method: "PATCH",
        url: `/api/bots/${bot.id}/soul`,
        headers,
        payload: { body: "blocked", expectedVersion: soulVersion },
      })
    ).statusCode,
  ).toBe(409);
  expect(ctx.sessions.get(bot.id, thread.id)).toBe("session-before-soul-change");
  ctx.db.prepare("UPDATE runs SET status='cancelled' WHERE id=?").run(parked.id);
  expect(
    (
      await app.inject({
        method: "PATCH",
        url: `/api/bots/${bot.id}/soul`,
        headers,
        payload: { body: "stale", expectedVersion: "0".repeat(64) },
      })
    ).statusCode,
  ).toBe(409);
  expect(files.get("SOUL.md")).toBe("You are a writer.");
  const savedSoul = await app.inject({
    method: "PATCH",
    url: `/api/bots/${bot.id}/soul`,
    headers,
    payload: { body: "You are a careful writer.", expectedVersion: soulVersion },
  });
  expect(savedSoul.statusCode).toBe(200);
  // SOUL is canonical Gateway configuration (migration 0019); runs receive it, so the edit
  // does not write the workspace file.
  expect(ctx.bots.canonicalSoul(bot.id)?.body).toBe("You are a careful writer.");
  expect(files.get("SOUL.md")).toBe("You are a writer.");
  expect(ctx.bots.mustGet(bot.id).soulVersion).toBe(2);
  expect(ctx.sessions.get(bot.id, thread.id)).toBeUndefined();

  const listed = await app.inject({
    method: "GET",
    url: `/api/memory-suggestions?botId=${bot.id}`,
    headers,
  });
  const suggestion = listed.json().suggestions[0];
  expect(suggestion).toMatchObject({ runId: run.id, botId: bot.id, status: "pending" });
  const applied = await app.inject({
    method: "POST",
    url: `/api/memory-suggestions/${suggestion.id}/review`,
    headers,
    payload: { decision: "apply" },
  });
  expect(applied.statusCode).toBe(200);
  expect(applied.json().suggestion).toMatchObject({ status: "applied", runId: run.id });
  // ADR-0011: the applied item is a trusted bot-scope note with the human as source; MEMORY.md,
  // the operator's file, is not touched.
  expect(applied.json().entry).toMatchObject({
    scope: "bot",
    kind: "note",
    trust: "trusted",
    sourceKind: "human",
    body: "Always check the refund queue.",
  });
  expect(files.get("MEMORY.md")).toBe("");
  expect(writes).toEqual([]);
  const repeated = await app.inject({
    method: "POST",
    url: `/api/memory-suggestions/${suggestion.id}/review`,
    headers,
    payload: { decision: "apply" },
  });
  expect(repeated.statusCode).toBe(200);
  expect(repeated.json().entry.id).toBe(applied.json().entry.id);
  const exported = await app.inject({
    method: "GET",
    url: `/api/bots/${bot.id}/memory/export`,
    headers,
  });
  expect(exported.body).toContain("Always check the refund queue.");
  expect(writes).toEqual([]);
});
