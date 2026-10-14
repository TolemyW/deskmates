import type { RunId } from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGateway } from "../index.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { TEST_OPERATOR_TOKEN, testConfig } from "../test-support/harness.js";

let app: ReturnType<typeof buildGateway>;
beforeEach(async () => {
  app = buildGateway(testConfig({ browserCoordinationMode: "origin-v2" }), new FakeProvider(), {
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
  const ws = ctx.workspaces.create({ name: "origin", sandboxProvider: "docker" });
  const bot = ctx.bots.create({ workspaceId: ws.id, name: "alice", role: "tester" });
  const thread = ctx.threads.create({ workspaceId: ws.id, botIds: [bot.id] });
  const run = ctx.router.postHuman({ threadId: thread.id, body: "check" }).runs[0];
  if (!run) throw new Error("no run");
  const a = lifecycle.start(run);
  const b = lifecycle.start(
    ctx.runs.create({
      botId: bot.id,
      lane: "background",
      triggerKind: "webhook",
      triggerRef: "test",
      triggerPayload: { body: "check" },
      config: ctx.runConfig(),
    }),
  );
  return { ws, a, b };
}

function post(
  run: { run: { id: RunId }; token: string },
  payload: Record<string, unknown>,
  token = run.token,
) {
  return app.inject({
    method: "POST",
    url: `/internal/runs/${run.run.id}/browser-origin`,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}
function ops(id: RunId) {
  return app.deskmates.ctx.events
    .list(id)
    .filter((e) => e.payload.source === "browser_origin")
    .map((e) => e.payload.op);
}

describe("origin admission API", () => {
  it("snapshots opt-in for chat and background starts with a bounded deadline", async () => {
    const before = Date.now();
    const { a, b } = seed();
    for (const prepared of [a, b]) {
      expect(prepared.run.config.browserCoordinationMode).toBe("origin-v2");
      expect(prepared.request.browserCoordination?.mode).toBe("origin-v2");
      const deadline = Date.parse(prepared.request.browserCoordination?.deadlineAt ?? "");
      expect(deadline).toBeGreaterThanOrEqual(before + 30_000);
      expect(deadline).toBeLessThanOrEqual(Date.now() + 30_000);
    }
    app.deskmates.ctx.config.browserCoordinationMode = "tab-v1";
    expect((await post(a, { op: "acquire", origin: "https://example.test" })).json().granted).toBe(
      true,
    );
  });

  it("authenticates the route run, validates origins, and prevents body-based opt-in", async () => {
    const { a, b } = seed();
    expect(
      (await post(a, { op: "acquire", origin: "https://example.test" }, b.token)).statusCode,
    ).toBe(401);
    for (const origin of [
      "file:///tmp",
      "https://user:pass@example.test",
      "https://example.test/path",
      "https://example.test?x=1",
      123,
    ]) {
      expect((await post(a, { op: "acquire", origin })).statusCode).toBe(400);
    }
    expect((await post(a, { op: "acquire" })).statusCode).toBe(400);
    expect((await post(a, { op: "renew" })).statusCode).toBe(400);
    app.deskmates.ctx.runs.setConfig(a.run.id, { browserCoordinationMode: "tab-v1" });
    expect(
      (
        await post(a, {
          op: "acquire",
          origin: "https://example.test",
          browserCoordinationMode: "origin-v2",
        })
      ).statusCode,
    ).toBe(400);
  });

  it("queues once, ignores a spoofed body runId, and audits only state transitions", async () => {
    const { ws, a, b } = seed();
    const origin = "https://example.test";
    expect((await post(a, { op: "acquire", origin })).json().granted).toBe(true);
    for (let i = 0; i < 3; i++)
      expect((await post(b, { op: "acquire", origin, runId: a.run.id })).json().waitReason).toBe(
        "origin_busy",
      );
    expect(ops(a.run.id)).toEqual(["granted"]);
    expect(ops(b.run.id)).toEqual(["queued"]);
    await post(b, { op: "release", origin: "https://other.test", runId: a.run.id });
    expect(app.deskmates.ctx.originQueue.list(ws.id)).toHaveLength(2);
    await post(a, { op: "release", origin });
    expect((await post(b, { op: "acquire", origin })).json().granted).toBe(true);
    app.deskmates.lifecycle.fail(b.run.id, "test failure");
    expect(app.deskmates.ctx.originQueue.list(ws.id)).toEqual([]);
    expect(ops(a.run.id)).toEqual(["granted", "released"]);
    expect(ops(b.run.id)).toEqual(["queued", "granted", "released"]);
    expect((await post(b, { op: "acquire", origin })).statusCode).toBe(401);
  });

  it("audits one lease_lost edge until the same origin is acquired again", async () => {
    const { a } = seed();
    const origin = "https://example.test";
    expect((await post(a, { op: "acquire", origin })).json().granted).toBe(true);
    app.deskmates.ctx.db
      .prepare("UPDATE browser_origin_queue SET expires_at = ? WHERE run_id = ?")
      .run("2020-01-01T00:00:00.000Z", a.run.id);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await post(a, { op: "renew", origin })).json().waitReason).toBe("lease_lost");
    }
    expect(ops(a.run.id)).toEqual(["granted", "lease_lost"]);

    expect((await post(a, { op: "acquire", origin })).json().granted).toBe(true);
    app.deskmates.ctx.db
      .prepare("UPDATE browser_origin_queue SET expires_at = ? WHERE run_id = ?")
      .run("2020-01-01T00:00:00.000Z", a.run.id);
    expect((await post(a, { op: "renew", origin })).json().waitReason).toBe("lease_lost");
    expect(ops(a.run.id)).toEqual(["granted", "lease_lost", "granted", "lease_lost"]);
  });

  it("preempts for takeover and releases both parked and completed runs", async () => {
    const { ws, a, b } = seed();
    const origin = "https://example.test";
    await post(a, { op: "acquire", origin });
    await post(b, { op: "acquire", origin });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/workspaces/${ws.id}/takeover`,
          headers: { authorization: `Bearer ${TEST_OPERATOR_TOKEN}` },
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect(app.deskmates.ctx.originQueue.list(ws.id).map((e) => e.status)).toEqual([
      "pending",
      "pending",
    ]);
    expect(ops(a.run.id)).toEqual(["granted", "preempted"]);
    expect((await post(b, { op: "acquire", origin })).json().waitReason).toBe("human");
    app.deskmates.lifecycle.ended(a.run.id, {
      type: "run_ended",
      runId: a.run.id,
      outcome: "deferred",
      sdkSessionId: "session-test",
      usage: [],
    });
    app.deskmates.lifecycle.ended(b.run.id, {
      type: "run_ended",
      runId: b.run.id,
      outcome: "completed",
      usage: [],
    });
    expect(app.deskmates.ctx.originQueue.list(ws.id)).toEqual([]);
    expect(ops(a.run.id).at(-1)).toBe("released");
    expect(ops(b.run.id).at(-1)).toBe("released");
  });
});
