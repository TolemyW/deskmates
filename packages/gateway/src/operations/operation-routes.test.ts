// T1: the operation proxy (ADR-0040 decisions 1, 2, 4, 6, 8, 9 and 10) against the testkit fake
// operation upstream; no socket leaves the process except the Gateway's own loopback listener.

import { FakeOperationUpstream } from "@deskmates/testkit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BudgetVerdict } from "../budget/budget-store.js";
import type { GatewayConfig } from "../config.js";
import { readOperationsConfig } from "../config/operations.js";
import { sidecarToolsFor } from "../scheduler/sidecar-tools.js";
import { type Harness, startHarness } from "../test-support/harness.js";
import { operationStore, setOperationFetch } from "./operation-routes.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 1),
]);
const WAV = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.alloc(4),
  Buffer.from("WAVEfmt "),
  Buffer.alloc(32, 2),
]);
const UPSTREAM_TOKEN = "vision-upstream-secret-81f2";

function operationsConfig(env: Record<string, string> = {}): Partial<GatewayConfig> {
  return readOperationsConfig({
    VISION_OPERATION_URL: "http://fake-operations.test",
    VISION_OPERATION_MODEL: "qwen3.5-9b-vl",
    VISION_OPERATION_AUTH_TOKEN: UPSTREAM_TOKEN,
    VISION_OPERATION_PRICE_USD: "0",
    ASR_OPERATION_URL: "http://fake-operations.test",
    ASR_OPERATION_MODEL: "whisper-large-v3",
    ASR_OPERATION_MAX_SECONDS: "60",
    ...env,
  });
}

async function setup(overrides: Partial<GatewayConfig> = operationsConfig()) {
  const h = await startHarness(overrides);
  cleanup.push(() => h.close());
  const upstream = new FakeOperationUpstream();
  setOperationFetch(h.app.deskmates.ctx, upstream.fetch);
  const { bot, thread, workspace } = await h.seed();
  const { ctx } = h.app.deskmates;
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

async function post(
  h: Harness,
  runId: string,
  token: string,
  op: "look" | "asr",
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${h.baseUrl}/internal/runs/${runId}/operations/${op}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const lookBody = (extra: Record<string, unknown> = {}) => ({
  mode: "ocr",
  mediaType: "image/png",
  data: PNG.toString("base64"),
  unit: "image",
  source: { path: "/work/receipt.png" },
  ...extra,
});

const asrBody = (extra: Record<string, unknown> = {}) => ({
  mediaType: "audio/wav",
  data: WAV.toString("base64"),
  fileName: "note.wav",
  source: { path: "/work/uploads/note.wav" },
  ...extra,
});

describe("configuration and tools", () => {
  it("offers both tools and stamps model and endpoint hash only when configured", async () => {
    const { ctx } = await setup();
    const config = ctx.runConfig();
    expect(config.operations).toEqual({
      look: { model: "qwen3.5-9b-vl", endpointSha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
      asr: { model: "whisper-large-v3", endpointSha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
    expect(sidecarToolsFor(true, config)).toEqual(
      expect.arrayContaining(["image_describe", "audio_transcribe"]),
    );
    const bare = await setup({});
    expect(bare.ctx.runConfig().operations).toBeUndefined();
    expect(sidecarToolsFor(true, bare.ctx.runConfig())).not.toContain("image_describe");
    expect(sidecarToolsFor(true, bare.ctx.runConfig())).not.toContain("audio_transcribe");
    // Unconfigured: the route says so and nothing is forwarded.
    const res = await post(bare.h, bare.run.id, bare.token, "look", lookBody());
    expect(res.status).toBe(404);
    expect(bare.upstream.requests).toHaveLength(0);
  });

  it("queues no probe and calls no service when the Gateway starts", async () => {
    const { upstream, ctx } = await setup();
    expect(upstream.requests).toHaveLength(0);
    const probes = ctx.db.prepare("SELECT COUNT(*) AS n FROM model_capability_probes").get() as {
      n: number;
    };
    expect(probes.n).toBe(0);
  });
});

describe("look", () => {
  it("forwards one request with the configured model and records the call", async () => {
    const { h, upstream, ctx, run, token } = await setup();
    const res = await post(h, run.id, token, "look", lookBody({ model: "attacker-model" }));
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      model: "qwen3.5-9b-vl",
      text: "INVOICE 4711\nTotal: 12.00",
      usage: {
        unit: "image",
        quantity: 1,
        measured: "computed",
        inputTokens: 812,
        outputTokens: 14,
        costUsd: 0,
      },
    });
    expect(upstream.requests).toHaveLength(1);
    const sent = upstream.requests[0];
    expect(sent?.path).toBe("/v1/messages");
    expect(sent?.json?.model).toBe("qwen3.5-9b-vl");
    expect(sent?.headers.authorization).toBe(`Bearer ${UPSTREAM_TOKEN}`);
    const rows = operationStore(ctx).forRun(run.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      operation: "look",
      mode: "ocr",
      status: "succeeded",
      unit: "image",
      quantity: 1,
      cost_usd: 0,
      input_bytes: PNG.length,
      attempt: run.attempt,
    });
    expect(JSON.stringify(rows)).not.toContain(UPSTREAM_TOKEN);
  });

  it("records a page as a page and leaves cost unknown without a price", async () => {
    const { h, ctx, run, token } = await setup(
      operationsConfig({ VISION_OPERATION_PRICE_USD: "" }),
    );
    const res = await post(
      h,
      run.id,
      token,
      "look",
      lookBody({ unit: "page", source: { path: "/work/a.pdf", page: 2 } }),
    );
    expect(res.json.usage).toMatchObject({ unit: "page", quantity: 1, costUsd: null });
    expect(operationStore(ctx).forRun(run.id)[0]?.cost_usd).toBeNull();
  });

  it("refuses bad input before any upstream call", async () => {
    const { h, upstream, run, token } = await setup();
    const cases: Array<[Record<string, unknown>, number]> = [
      [{ mode: "translate" }, 400],
      [{ unit: "audio_second" }, 400],
      [{ question: "x".repeat(2001) }, 400],
      [{ mediaType: "image/jpeg" }, 400],
      [{ data: Buffer.from("not an image at all").toString("base64") }, 400],
      [{ data: "!!!!" }, 400],
      [{ source: {} }, 400],
    ];
    for (const [extra, status] of cases) {
      const res = await post(h, run.id, token, "look", lookBody(extra));
      expect(res.status, JSON.stringify(extra)).toBe(status);
    }
    expect(upstream.requests).toHaveLength(0);
  });

  it("refuses another run's token", async () => {
    const { h, upstream, run, newRun } = await setup();
    const other = newRun();
    const res = await post(h, run.id, other.token, "look", lookBody());
    expect(res.status).toBe(401);
    expect(upstream.requests).toHaveLength(0);
  });

  it.each([
    [{ status: 503, body: { error: "overloaded" } }, "answered_error"],
    [{ raw: "<html>" }, "answered_malformed"],
    [{ body: { unexpected: true } }, "answered_malformed"],
    [{ error: "network" as const }, "unreachable"],
  ])("fails once with no retry: %j", async (reply, reason) => {
    const { h, upstream, ctx, run, token } = await setup();
    upstream.next(reply);
    const res = await post(h, run.id, token, "look", lookBody());
    expect(res.status).toBe(502);
    expect(res.json).toMatchObject({ code: "operation_unavailable", details: { reason } });
    expect(JSON.stringify(res.json)).not.toContain(UPSTREAM_TOKEN);
    expect(upstream.requests).toHaveLength(1);
    expect(operationStore(ctx).forRun(run.id)).toEqual([
      expect.objectContaining({
        status: "failed",
        error_code: reason,
        quantity: null,
        measured: "unknown",
      }),
    ]);
  });

  it("refuses an exhausted workspace with no upstream call", async () => {
    const { h, upstream, ctx, run, token } = await setup();
    vi.spyOn(ctx.budget, "verdict").mockReturnValue({
      exhausted: "weekly",
      limitUsd: 1,
      spendUsd: 2,
    } as unknown as BudgetVerdict);
    const res = await post(h, run.id, token, "look", lookBody());
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("budget_exhausted");
    expect(upstream.requests).toHaveLength(0);
    expect(operationStore(ctx).forRun(run.id)).toEqual([
      expect.objectContaining({
        status: "refused",
        error_code: "budget_exhausted",
        quantity: null,
      }),
    ]);
  });
});

describe("asr", () => {
  it("sends the file as multipart and records provider seconds", async () => {
    const { h, upstream, ctx, run, token } = await setup(
      operationsConfig({ ASR_OPERATION_PRICE_USD: "0.001" }),
    );
    const res = await post(
      h,
      run.id,
      token,
      "asr",
      asrBody({ language: "en", durationSeconds: 3 }),
    );
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      text: "hello world",
      language: "en",
      durationSeconds: 3.5,
      usage: { unit: "audio_second", quantity: 3.5, measured: "provider", costUsd: 0.0035 },
    });
    const sent = upstream.requests[0];
    expect(sent?.path).toBe("/v1/audio/transcriptions");
    expect(sent?.fields).toEqual({
      model: "whisper-large-v3",
      response_format: "verbose_json",
      language: "en",
    });
    expect(sent?.file?.bytes.equals(WAV)).toBe(true);
    expect(sent?.headers.authorization).toBeUndefined();
    expect(operationStore(ctx).forRun(run.id)[0]).toMatchObject({
      operation: "asr",
      unit: "audio_second",
      quantity: 3.5,
      measured: "provider",
    });
  });

  it("falls back to the computed duration, else unknown", async () => {
    const { h, upstream, run, token } = await setup();
    upstream.next({ body: { text: "a" } }).next({ body: { text: "b" } });
    const computed = await post(h, run.id, token, "asr", asrBody({ durationSeconds: 4 }));
    expect(computed.json.usage).toMatchObject({ quantity: 4, measured: "computed" });
    const unknown = await post(h, run.id, token, "asr", asrBody());
    expect(unknown.json).toMatchObject({ durationSeconds: null, language: null });
    expect(unknown.json.usage).toMatchObject({
      quantity: null,
      measured: "unknown",
      costUsd: null,
    });
  });

  it("refuses an overlong WAV, a bad language and a non-audio file before any call", async () => {
    const { h, upstream, run, token } = await setup();
    expect((await post(h, run.id, token, "asr", asrBody({ durationSeconds: 61 }))).status).toBe(
      413,
    );
    expect((await post(h, run.id, token, "asr", asrBody({ language: "EN-us" }))).status).toBe(400);
    expect((await post(h, run.id, token, "asr", asrBody({ fileName: "../x.wav" }))).status).toBe(
      400,
    );
    expect(
      (await post(h, run.id, token, "asr", asrBody({ data: PNG.toString("base64") }))).status,
    ).toBe(400);
    expect(upstream.requests).toHaveLength(0);
  });

  it("refuses a file above the configured size", async () => {
    const { h, upstream, run, token } = await setup(
      operationsConfig({ ASR_OPERATION_MAX_BYTES: "40" }),
    );
    const res = await post(h, run.id, token, "asr", asrBody());
    expect(res.status).toBe(413);
    expect(upstream.requests).toHaveLength(0);
  });
});
