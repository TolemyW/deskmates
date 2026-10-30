// T1: the text-to-image operation (ADR-0040 amendment B, decisions 16 to 19, 22 and 24) through
// the operation proxy against the testkit fake upstream; nothing leaves the process.

import { FakeOperationUpstream, fakePng } from "@deskmates/testkit";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../config.js";
import { readOperationsConfig } from "../config/operations.js";
import { sidecarToolsFor } from "../scheduler/sidecar-tools.js";
import { type Harness, startHarness } from "../test-support/harness.js";
import { operationStore, setOperationFetch } from "./operation-routes.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const TOKEN = "image-upstream-secret-5c1e";

function imageConfig(env: Record<string, string> = {}): Partial<GatewayConfig> {
  return readOperationsConfig({
    IMAGE_OPERATION_URL: "http://fake-operations.test",
    IMAGE_OPERATION_MODEL: "local-image-model",
    IMAGE_OPERATION_AUTH_TOKEN: TOKEN,
    IMAGE_OPERATION_PRICE_USD: "0",
    ...env,
  });
}

async function setup(overrides: Partial<GatewayConfig> = imageConfig()) {
  const h = await startHarness(overrides);
  cleanup.push(() => h.close());
  const upstream = new FakeOperationUpstream();
  const { ctx } = h.app.deskmates;
  setOperationFetch(ctx, upstream.fetch);
  const { bot, thread, workspace } = await h.seed();
  const newRun = () => {
    const run = ctx.runs.create({
      botId: bot.id,
      threadId: thread.id,
      lane: "interactive",
      triggerKind: "thread_message",
      triggerRef: "test",
      config: ctx.runConfig(),
    });
    return { run, token: ctx.tokens.issue(run.id).token };
  };
  return { h, upstream, ctx, workspace, newRun, ...newRun() };
}

async function post(h: Harness, runId: string, token: string, body: unknown) {
  const res = await fetch(`${h.baseUrl}/internal/runs/${runId}/operations/image_generation`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("configuration (decisions 17 and 24)", () => {
  it("offers image_generate and stamps the run only when configured, and probes nothing", async () => {
    const { ctx, upstream } = await setup();
    expect(ctx.runConfig().operations).toEqual({
      image_generation: {
        model: "local-image-model",
        endpointSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    expect(sidecarToolsFor(true, ctx.runConfig())).toContain("image_generate");
    expect(sidecarToolsFor(true, ctx.runConfig())).not.toContain("image_describe");
    expect(upstream.requests).toHaveLength(0);

    const bare = await setup({});
    expect(bare.ctx.runConfig().operations).toBeUndefined();
    expect(sidecarToolsFor(true, bare.ctx.runConfig())).not.toContain("image_generate");
    const res = await post(bare.h, bare.run.id, bare.token, { prompt: "a cube" });
    expect(res.status).toBe(404);
    expect(bare.upstream.requests).toHaveLength(0);
  });
});

describe("one bounded generation (decisions 16, 18, 19 and 22)", () => {
  it("forwards the fixed body once, returns checked images and records the call", async () => {
    const { h, upstream, ctx, run, token } = await setup(
      imageConfig({ IMAGE_OPERATION_PRICE_USD: "0.02" }),
    );
    const res = await post(h, run.id, token, {
      prompt: "a red cube on a desk",
      size: "512x768",
      count: 2,
      model: "attacker-model",
      response_format: "url",
    });
    expect(res.status).toBe(200);
    expect(upstream.requests).toHaveLength(1);
    const sent = upstream.requests[0];
    expect(sent?.path).toBe("/v1/images/generations");
    expect(sent?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(sent?.json).toEqual({
      model: "local-image-model",
      prompt: "a red cube on a desk",
      n: 2,
      size: "512x768",
      response_format: "b64_json",
    });
    const images = res.json.images as Record<string, unknown>[];
    expect(images).toHaveLength(2);
    expect(images[0]).toMatchObject({
      mediaType: "image/png",
      width: 512,
      height: 768,
      bytes: fakePng(512, 768).length,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(res.json).toMatchObject({
      model: "local-image-model",
      revisedPrompt: null,
      usage: { unit: "image", quantity: 2, measured: "computed", costUsd: 0.04 },
    });
    const rows = operationStore(ctx).forRun(run.id);
    expect(rows).toEqual([
      expect.objectContaining({
        operation: "image_generation",
        mode: null,
        status: "succeeded",
        unit: "image",
        quantity: 2,
        cost_usd: 0.04,
        input_bytes: Buffer.byteLength("a red cube on a desk"),
      }),
    ]);
    // Charged at once (amendment A, decision 12); no prompt text and no token in the record.
    const charged = ctx.db
      .prepare("SELECT sum(known_usd) AS usd FROM budget_charges WHERE run_id = ?")
      .get(run.id) as { usd: number };
    expect(charged.usd).toBe(0.04);
    expect(JSON.stringify(rows)).not.toContain("red cube");
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
  });

  it("uses the installation default size and one image when the call names none", async () => {
    const { h, upstream, run, token } = await setup(
      imageConfig({ IMAGE_OPERATION_DEFAULT_SIZE: "768x512" }),
    );
    expect((await post(h, run.id, token, { prompt: "x" })).status).toBe(200);
    expect(upstream.requests[0]?.json).toMatchObject({ n: 1, size: "768x512" });
  });

  it("refuses bad prompts, sizes and counts before any call", async () => {
    const { h, upstream, run, token } = await setup();
    for (const body of [
      {},
      { prompt: "" },
      { prompt: "   " },
      { prompt: "x".repeat(4001) },
      { prompt: "x", size: "1000x1000" },
      { prompt: "x", size: 1024 },
      { prompt: "x", count: 0 },
      { prompt: "x", count: 5 },
      { prompt: "x", count: 1.5 },
    ]) {
      const res = await post(h, run.id, token, body);
      expect(res.status, JSON.stringify(body).slice(0, 40)).toBe(400);
    }
    expect(upstream.requests).toHaveLength(0);
  });

  it("refuses another run's token", async () => {
    const { h, upstream, run, newRun } = await setup();
    const other = newRun();
    expect((await post(h, run.id, other.token, { prompt: "x" })).status).toBe(401);
    expect(upstream.requests).toHaveLength(0);
  });

  it.each([
    [{ status: 503, body: { error: "busy" } }, "answered_error"],
    [{ error: "network" as const }, "unreachable"],
    [{ body: { data: [{ url: "http://elsewhere.test/a.png" }] } }, "answered_malformed"],
    [
      { body: { data: [{ b64_json: Buffer.from("not an image at all").toString("base64") }] } },
      "answered_malformed",
    ],
    [{ body: { data: [{ b64_json: "!!!!" }] } }, "answered_malformed"],
    [
      {
        body: {
          data: [
            { b64_json: fakePng(8, 8).toString("base64") },
            { b64_json: fakePng(8, 8).toString("base64") },
          ],
        },
      },
      "answered_malformed",
    ],
  ])("fails once with no retry and fetches no URL: %j", async (reply, reason) => {
    const { h, upstream, ctx, run, token } = await setup();
    upstream.next(reply);
    const res = await post(h, run.id, token, { prompt: "x" });
    expect(res.status).toBe(502);
    expect(res.json).toMatchObject({ code: "operation_unavailable", details: { reason } });
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests.some((r) => r.url.includes("elsewhere"))).toBe(false);
    expect(operationStore(ctx).forRun(run.id)).toEqual([
      expect.objectContaining({ status: "failed", error_code: reason, quantity: null }),
    ]);
  });

  it("passes on a revised prompt as the service's text", async () => {
    const { h, upstream, run, token } = await setup();
    upstream.next({
      body: {
        data: [{ b64_json: fakePng(256, 256).toString("base64"), revised_prompt: "a cube, red" }],
      },
    });
    const res = await post(h, run.id, token, { prompt: "x" });
    expect(res.json.revisedPrompt).toBe("a cube, red");
  });

  it("refuses an exhausted workspace with no upstream call", async () => {
    const { h, upstream, ctx, workspace, run, token } = await setup();
    ctx.budget.setLimits(workspace.id, { weeklyLimitUsd: 1 }, "admin");
    ctx.db
      .prepare(
        `INSERT INTO budget_charges (workspace_id, run_id, charged_at, known_usd, estimated_usd,
           unmeasured_usage_delta, unestimated_usage_delta) VALUES (?, 'other', ?, 2, 0, 0, 0)`,
      )
      .run(workspace.id, new Date().toISOString());
    const res = await post(h, run.id, token, { prompt: "x" });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("budget_exhausted");
    expect(upstream.requests).toHaveLength(0);
    expect(operationStore(ctx).forRun(run.id)).toEqual([
      expect.objectContaining({ status: "refused", error_code: "budget_exhausted" }),
    ]);
  });
});
