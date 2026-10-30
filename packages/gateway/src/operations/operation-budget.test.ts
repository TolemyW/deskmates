// T1: operation spend in the workspace budget (ADR-0040 amendment A, decisions 12, 13 and 15),
// through the operation proxy against the testkit fake upstream.

import { FakeOperationUpstream } from "@deskmates/testkit";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../config.js";
import { readOperationsConfig } from "../config/operations.js";
import { runSpend } from "../ledger/costs.js";
import { type Harness, startHarness } from "../test-support/harness.js";
import { setOperationFetch } from "./operation-routes.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 1),
]);
const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(32, 3)]);

function config(env: Record<string, string>): Partial<GatewayConfig> {
  return readOperationsConfig({
    VISION_OPERATION_URL: "http://fake-operations.test",
    VISION_OPERATION_MODEL: "vl-model",
    ASR_OPERATION_URL: "http://fake-operations.test",
    ASR_OPERATION_MODEL: "whisper",
    ...env,
  });
}

async function setup(env: Record<string, string>, transcript?: { text: string }) {
  const h = await startHarness(config(env));
  cleanup.push(() => h.close());
  const upstream = new FakeOperationUpstream(transcript ? { transcript } : {});
  const { ctx } = h.app.deskmates;
  setOperationFetch(ctx, upstream.fetch);
  const { bot, thread, workspace } = await h.seed();
  const run = ctx.runs.create({
    botId: bot.id,
    threadId: thread.id,
    lane: "interactive",
    triggerKind: "thread_message",
    triggerRef: "test",
    config: ctx.runConfig(),
  });
  const token = ctx.tokens.issue(run.id).token;
  const charges = () =>
    ctx.db
      .prepare(
        `SELECT known_usd, estimated_usd, unmeasured_usage_delta, unestimated_usage_delta
           FROM budget_charges WHERE run_id = ? ORDER BY id`,
      )
      .all(run.id) as {
      known_usd: number;
      estimated_usd: number;
      unmeasured_usage_delta: number;
      unestimated_usage_delta: number;
    }[];
  return { h, upstream, ctx, workspace, run, token, charges };
}

async function post(h: Harness, runId: string, token: string, op: "look" | "asr", body: unknown) {
  const res = await fetch(`${h.baseUrl}/internal/runs/${runId}/operations/${op}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const look = {
  mode: "ocr",
  mediaType: "image/png",
  data: PNG.toString("base64"),
  unit: "image",
  source: { path: "/work/a.png" },
};
const asr = {
  mediaType: "audio/mpeg",
  data: MP3.toString("base64"),
  fileName: "a.mp3",
  source: { path: "/work/a.mp3" },
};

describe("operation spend in budget_charges (decision 12)", () => {
  it("charges a priced call as soon as it is recorded, once", async () => {
    const { h, ctx, run, token, charges } = await setup({ VISION_OPERATION_PRICE_USD: "0.006" });
    expect((await post(h, run.id, token, "look", look)).status).toBe(200);
    expect(runSpend(ctx.db, run.id)).toMatchObject({ knownUsd: 0.006, estimatedUsd: 0 });
    expect(charges()).toEqual([
      { known_usd: 0.006, estimated_usd: 0, unmeasured_usage_delta: 0, unestimated_usage_delta: 0 },
    ]);
    // A later charge moment (a model response, the final usage) appends nothing new.
    expect(ctx.budget.charge(run.id)).toBe(false);
    expect(charges()).toHaveLength(1);
  });

  it("charges a known zero as nothing and a refusal as nothing", async () => {
    const { h, ctx, workspace, run, token, charges } = await setup({
      VISION_OPERATION_PRICE_USD: "0",
    });
    expect((await post(h, run.id, token, "look", look)).status).toBe(200);
    expect(charges()).toEqual([]);
    expect(runSpend(ctx.db, run.id)).toMatchObject({
      knownUsd: 0,
      unmeasuredUsageCount: 0,
      unestimatedUsageCount: 0,
    });
    // An exhausted workspace refuses before the service; the refusal charges nothing.
    ctx.budget.setLimits(workspace.id, { weeklyLimitUsd: 1 }, "admin");
    ctx.db
      .prepare(
        `INSERT INTO budget_charges (workspace_id, run_id, charged_at, known_usd, estimated_usd,
           unmeasured_usage_delta, unestimated_usage_delta) VALUES (?, 'other', ?, 5, 0, 0, 0)`,
      )
      .run(workspace.id, new Date().toISOString());
    const refused = await post(h, run.id, token, "look", look);
    expect(refused.json.code).toBe("budget_exhausted");
    expect(charges()).toEqual([]);
  });

  it("counts an unknown quantity as unmeasured and a missing price as unestimated", async () => {
    // The fake transcription answers no duration and the MP3 carries none: quantity unknown.
    const unmeasured = await setup({ ASR_OPERATION_PRICE_USD: "0.001" }, { text: "hi" });
    expect((await post(unmeasured.h, unmeasured.run.id, unmeasured.token, "asr", asr)).status).toBe(
      200,
    );
    expect(unmeasured.charges()).toEqual([
      { known_usd: 0, estimated_usd: 0, unmeasured_usage_delta: 1, unestimated_usage_delta: 0 },
    ]);

    // No vision price, while the harness has token prices: no estimate is made (decision 13).
    const unpriced = await setup({});
    expect((await post(unpriced.h, unpriced.run.id, unpriced.token, "look", look)).status).toBe(
      200,
    );
    expect(unpriced.charges()).toEqual([
      { known_usd: 0, estimated_usd: 0, unmeasured_usage_delta: 0, unestimated_usage_delta: 1 },
    ]);
  });

  it("counts a failed call as unmeasured: the service may have done the work", async () => {
    const { h, upstream, run, token, charges } = await setup({ VISION_OPERATION_PRICE_USD: "1" });
    upstream.next({ status: 503, body: { error: "overloaded" } });
    expect((await post(h, run.id, token, "look", look)).status).toBe(502);
    expect(charges()).toEqual([
      { known_usd: 0, estimated_usd: 0, unmeasured_usage_delta: 1, unestimated_usage_delta: 0 },
    ]);
  });
});

describe("operations against the weekly limit (decisions 12 and 15)", () => {
  it("completes the call that crosses the limit, then refuses the next one", async () => {
    const { h, upstream, ctx, workspace, run, token } = await setup({
      VISION_OPERATION_PRICE_USD: "0.006",
    });
    ctx.budget.setLimits(workspace.id, { weeklyLimitUsd: 0.01 }, "admin");
    expect((await post(h, run.id, token, "look", look)).status).toBe(200);
    // 0.006 is under the limit: the second call is admitted and crosses it (bounded overshoot).
    expect((await post(h, run.id, token, "look", look)).status).toBe(200);
    expect(ctx.budget.spend(workspace.id).week.knownUsd).toBe(0.012);
    expect(ctx.budget.verdict(workspace.id).exhausted).toBe("weekly");
    const third = await post(h, run.id, token, "look", look);
    expect(third.status).toBe(409);
    expect(third.json.code).toBe("budget_exhausted");
    expect(upstream.requests).toHaveLength(2);
  });
});
