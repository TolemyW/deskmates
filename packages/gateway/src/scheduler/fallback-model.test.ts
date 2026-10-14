// T1: FALLBACK_MODEL and the ledger of what the SDK did with models (ADR-0023 decision 3; test
// plan FB-02 Gateway half, FB-04, FAULT-09 attribution). The fallback is frozen on the run row at
// start like the other models, travels in `StartRunRequest` verbatim, joins the run's frozen set
// at the proxy, and must be priced at startup. `model_switch` / `model_retry` events from the
// sidecar are ledger facts, and usage is priced per model actually served.

import type { RunId, StartRunRequest } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../config.js";
import { buildGateway } from "../index.js";
import type { RunRecord } from "../ledger/runs.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { type Harness, startHarness, testConfig, waitFor } from "../test-support/harness.js";

const priced = (model: string, inputPerM = 1) => ({
  model,
  inputPerM,
  outputPerM: 1,
  cacheReadPerM: 0,
  cacheCreatePerM: 0,
  effectiveFrom: "1970-01-01T00:00:00.000Z",
});

const PRICES = [
  priced("test-model-default", 3),
  priced("test-model-cheap", 1),
  priced("test-model-fallback", 2),
];

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function runOnce(
  overrides: Partial<GatewayConfig>,
  onRun?: Parameters<Harness["provider"]["onRun"]>[0],
): Promise<{ harness: Harness; run: RunRecord; request: StartRunRequest }> {
  h = await startHarness({ modelPrices: PRICES, ...overrides });
  const harness = h;
  const requests: StartRunRequest[] = [];
  harness.provider.onRun(async (req, gw) => {
    requests.push(req);
    if (onRun) return onRun(req, gw);
    await gw.post("ended", {
      type: "run_ended",
      runId: req.runId,
      outcome: "completed",
      summary: {
        done: "ok",
        filesChanged: [],
        sitesVisited: [],
        pendingApprovals: [],
        memorySuggestions: [],
        reply: "",
      },
      usage: [],
    });
  });
  const { thread } = await harness.seed();
  const posted = await harness.api<{ runs: RunRecord[] }>(
    "POST",
    `/api/threads/${thread.id}/messages`,
    { body: "hi" },
  );
  const id = (posted.json.runs[0] as RunRecord).id;
  await waitFor(
    () =>
      ["succeeded", "silent", "failed"].includes(harness.app.deskmates.ctx.runs.mustGet(id).status),
    3000,
    "run end",
  );
  const request = requests[0];
  if (!request) throw new Error("no start request");
  return { harness, run: harness.app.deskmates.ctx.runs.mustGet(id), request };
}

describe("FALLBACK_MODEL (ADR-0023 decision 3)", () => {
  it("travels in StartRunRequest verbatim and is frozen on the run row", async () => {
    const { run, request } = await runOnce({ fallbackModel: "test-model-fallback" });
    expect(request.fallbackModel).toBe("test-model-fallback");
    expect(run.config.fallbackModel).toBe("test-model-fallback");
  });

  it("is absent from the request when unset, and recorded as none", async () => {
    const { run, request } = await runOnce({});
    expect("fallbackModel" in request).toBe(false);
    expect(run.config.fallbackModel).toBeNull();
  });

  it("joins the run's frozen set at the proxy, and only for runs started with it", async () => {
    const upstream = (async () =>
      new Response(JSON.stringify({ model: "test-model-fallback" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    h = await startHarness({ modelPrices: PRICES, fallbackModel: "test-model-fallback" }, upstream);
    const harness = h;
    const call = async (runId: RunId) => {
      const issued = harness.app.deskmates.ctx.tokens.issue(runId);
      const res = await fetch(`${harness.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${issued.token}` },
        body: JSON.stringify({ model: "test-model-fallback", messages: [] }),
      });
      await res.arrayBuffer();
      return res.status;
    };
    const { thread } = await harness.seed();
    const posted = await harness.api<{ runs: RunRecord[] }>(
      "POST",
      `/api/threads/${thread.id}/messages`,
      { body: "hi" },
    );
    const withFallback = (posted.json.runs[0] as RunRecord).id;
    await waitFor(
      () => harness.app.deskmates.ctx.runs.mustGet(withFallback).config.fallbackModel !== undefined,
      2000,
      "start",
    );
    expect(await call(withFallback)).toBe(200);
    // A run frozen without a fallback (recorded null) does not gain one later.
    const ctx = harness.app.deskmates.ctx;
    ctx.runs.setConfig(withFallback, { fallbackModel: null });
    expect(await call(withFallback)).toBe(403);
  });

  it("FB-04: an unpriced FALLBACK_MODEL stops the Gateway at startup", () => {
    expect(() =>
      buildGateway(
        testConfig({ modelPrices: PRICES, fallbackModel: "test-model-unlisted" }),
        new FakeProvider(),
        { surface: "combined-test", startCron: false },
      ),
    ).toThrow(/FALLBACK_MODEL.*test-model-unlisted.*price/);
  });
});

describe("the ledger records switches, retries and per-model usage (FB-02, FAULT-09)", () => {
  it("stores model_switch and model_retry events and prices usage on both served models", async () => {
    const { harness, run } = await runOnce(
      { fallbackModel: "test-model-fallback" },
      async (req, gw) => {
        const ts = new Date().toISOString();
        const event = (seq: number, kind: string, payload: Record<string, unknown>) => ({
          type: "event",
          runId: req.runId,
          attempt: req.attempt,
          seq,
          kind,
          payload,
          ts,
        });
        const posted = await gw.post("events", [
          event(1, "tool_call", { toolUseId: "t1", toolName: "Write", input: {} }),
          event(2, "model_retry", {
            attempt: 1,
            maxRetries: 10,
            retryDelayMs: 500,
            errorStatus: 529,
            error: "overloaded",
          }),
          event(3, "model_switch", {
            from: "test-model-default",
            to: "test-model-fallback",
            source: "auto",
          }),
        ]);
        expect(posted.status).toBe(200);
        await gw.post("ended", {
          type: "run_ended",
          runId: req.runId,
          outcome: "completed",
          summary: {
            done: "ok",
            filesChanged: [],
            sitesVisited: [],
            pendingApprovals: [],
            memorySuggestions: [],
            reply: "",
          },
          usage: [
            {
              model: "test-model-default",
              inputTokens: 1_000_000,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheCreateTokens: 0,
            },
            {
              model: "test-model-fallback",
              inputTokens: 1_000_000,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheCreateTokens: 0,
            },
          ],
        });
      },
    );
    const ctx = harness.app.deskmates.ctx;
    const kinds = ctx.events.list(run.id).map((e) => e.kind);
    expect(kinds.filter((k) => k === "model_retry")).toHaveLength(1);
    expect(kinds.filter((k) => k === "model_switch")).toHaveLength(1);
    // FAULT-09: the tool call before the switch is in the ledger once.
    expect(kinds.filter((k) => k === "tool_call")).toHaveLength(1);
    const usage = ctx.usage
      .list(run.id)
      .map((u) => [u.model, u.costUsd])
      .sort();
    expect(usage).toEqual([
      ["test-model-default", 3],
      ["test-model-fallback", 2],
    ]);
    expect(kinds).not.toContain("pricing_missing");
  });
});
