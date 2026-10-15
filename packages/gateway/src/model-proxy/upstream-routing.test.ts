// T1: the model proxy routes each request to its model's upstream (ADR-0039 decisions 2, 3, 4
// and 5). Three fake upstreams: `default` (MODEL_BASE_URL, Bearer), `local` (no token, serves the
// cheap model) and `vl` (own token). Each sees only its own models, with its own credential and
// never the run token; frozen-model refusal and budget admission come first; an unroutable model
// is 503 `model_upstream_missing`; a failing or unreachable upstream is never retried elsewhere;
// a zero-priced local model costs a known 0.

import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type ModelPrice, type RunId, isTerminal } from "@deskmates/contracts";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayConfig } from "../config.js";
import { runSpend } from "../ledger/costs.js";
import { priceUsage } from "../ledger/pricing.js";
import type { RunTokenStore } from "../secrets/run-tokens.js";
import {
  type Harness,
  TEST_UPSTREAM_TOKEN,
  startHarness,
  waitFor,
} from "../test-support/harness.js";
import { registerModelProxy } from "./model-proxy.js";

interface Seen {
  path: string;
  authorization: string | undefined;
  model: unknown;
}

const servers: Server[] = [];
let h: Harness | undefined;

afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

/** A fake upstream recording what it saw; `fail: true` in the body answers 529. */
async function fakeUpstream(): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString("utf8");
    });
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as { model?: unknown; fail?: boolean };
      seen.push({
        path: req.url ?? "",
        authorization: req.headers.authorization,
        model: parsed.model,
      });
      if (parsed.fail) {
        res.writeHead(529, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg",
          model: parsed.model,
          usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
        }),
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const price = (model: string, perM: number): ModelPrice => ({
  model,
  inputPerM: perM,
  outputPerM: perM,
  cacheReadPerM: perM,
  cacheCreatePerM: perM,
  effectiveFrom: "1970-01-01T00:00:00.000Z",
});

async function startedRun(harness: Harness): Promise<RunId> {
  const { thread } = await harness.seed();
  const m = await harness.api<{ runs: { id: string }[] }>(
    "POST",
    `/api/threads/${thread.id}/messages`,
    { body: "hi" },
  );
  const runId = m.json.runs[0]?.id as RunId;
  await waitFor(
    () => isTerminal(harness.app.deskmates.ctx.runs.mustGet(runId).status),
    2000,
    "end",
  );
  return runId;
}

async function post(
  harness: Harness,
  runId: RunId,
  body: Record<string, unknown>,
  path = "/v1/messages",
): Promise<{ status: number; retry: string | null; json: Record<string, unknown> }> {
  const issued = harness.app.deskmates.ctx.tokens.issue(runId);
  const res = await fetch(`${harness.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${issued.token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    retry: res.headers.get("x-should-retry"),
    json: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

async function threeUpstreams(overrides: Partial<GatewayConfig> = {}) {
  const main = await fakeUpstream();
  const local = await fakeUpstream();
  const vl = await fakeUpstream();
  h = await startHarness({
    modelBaseUrl: main.url,
    cheapModel: "local-27b",
    cliSmallFastModel: "cli-small-fast",
    modelUpstreams: [
      { id: "local", baseUrl: local.url, models: ["local-27b"], protocol: "anthropic" },
      {
        id: "vl",
        baseUrl: vl.url,
        authToken: "vl-upstream-secret",
        models: ["local-vl"],
        protocol: "anthropic",
      },
    ],
    modelPrices: [price("test-model-default", 1), price("local-27b", 0)],
    ...overrides,
  });
  return { harness: h, main, local, vl };
}

describe("the model proxy routes by model to its upstream (ADR-0039)", () => {
  it("sends each frozen model to its own upstream with that upstream's credential", async () => {
    const { harness, main, local, vl } = await threeUpstreams();
    const runId = await startedRun(harness);
    const run = harness.app.deskmates.ctx.runs.mustGet(runId);
    // Decision 4: the run records where each frozen model was served.
    expect(run.config.modelUpstreams).toEqual({
      "test-model-default": "default",
      "local-27b": "local",
    });

    expect((await post(harness, runId, { model: "test-model-default" })).status).toBe(200);
    expect((await post(harness, runId, { model: "local-27b" })).status).toBe(200);
    expect(
      (await post(harness, runId, { model: "local-27b" }, "/v1/messages/count_tokens")).status,
    ).toBe(200);
    // The CLI's small-fast id is rewritten to the cheap model and routed by the rewritten id.
    expect((await post(harness, runId, { model: "cli-small-fast" })).status).toBe(200);

    expect(main.seen).toEqual([
      {
        path: "/v1/messages",
        authorization: `Bearer ${TEST_UPSTREAM_TOKEN}`,
        model: "test-model-default",
      },
    ]);
    // A token-less upstream gets no Authorization header at all: not the run token, not another's.
    expect(local.seen).toEqual([
      { path: "/v1/messages", authorization: undefined, model: "local-27b" },
      { path: "/v1/messages/count_tokens", authorization: undefined, model: "local-27b" },
      { path: "/v1/messages", authorization: undefined, model: "local-27b" },
    ]);
    expect(vl.seen).toEqual([]);

    // Usage and served_model are recorded for every upstream (ADR-0023 decision 3).
    await waitFor(
      () =>
        harness.app.deskmates.ctx.modelRequests.list(runId).every((r) => r.servedModel !== null),
      2000,
      "served models",
    );
    const rows = harness.app.deskmates.ctx.modelRequests.list(runId);
    expect(rows.map((r) => [r.requestKind, r.model, r.rewrittenFrom, r.servedModel])).toEqual([
      ["messages", "test-model-default", null, "test-model-default"],
      ["messages", "local-27b", null, "local-27b"],
      ["count_tokens", "local-27b", null, "local-27b"],
      ["messages", "local-27b", "cli-small-fast", "local-27b"],
    ]);

    // Decision 5: the zero-priced local model is a known 0, not unpriced and not estimated.
    const spend = runSpend(harness.app.deskmates.ctx.db, runId);
    expect(spend).toMatchObject({ estimatedUsd: 0, unestimatedUsageCount: 0 });
    expect(spend?.knownUsd).toBe(2);
  });

  it("refuses an unfrozen model before routing: no upstream sees it", async () => {
    const { harness, main, local, vl } = await threeUpstreams();
    const runId = await startedRun(harness);
    const refused = await post(harness, runId, { model: "local-vl" });
    expect(refused.status).toBe(403);
    expect(refused.json.code).toBe("model_not_selected");
    expect([...main.seen, ...local.seen, ...vl.seen]).toEqual([]);
  });

  it("answers 503 model_upstream_missing, final, for a frozen model no upstream serves", async () => {
    const local = await fakeUpstream();
    h = await startHarness({
      modelBaseUrl: "",
      modelAuthToken: "",
      defaultModel: "local-27b",
      cheapModel: "local-27b",
      modelUpstreams: [
        { id: "local", baseUrl: local.url, models: ["local-27b"], protocol: "anthropic" },
      ],
    });
    const harness = h;
    const runId = await startedRun(harness);
    // A run frozen before the registry dropped its model (a restart with a new `.env`).
    harness.app.deskmates.ctx.runs.setConfig(runId, { model: "retired-model" });
    const res = await post(harness, runId, { model: "retired-model" });
    expect(res.status).toBe(503);
    expect(res.retry).toBe("false");
    expect(res.json).toMatchObject({
      code: "model_upstream_missing",
      details: { model: "retired-model" },
    });
    expect(local.seen).toEqual([]);
    expect((await post(harness, runId, { model: "local-27b" })).status).toBe(200);
    expect(local.seen).toHaveLength(1);
  });

  it("never falls back: a failing or unreachable upstream's answer is the answer", async () => {
    const { harness, main, local } = await threeUpstreams({
      modelUpstreams: [
        {
          id: "local",
          baseUrl: "http://127.0.0.1:1",
          models: ["local-27b"],
          protocol: "anthropic",
        },
      ],
    });
    const runId = await startedRun(harness);
    expect((await post(harness, runId, { model: "local-27b" })).status).toBe(502);
    expect((await post(harness, runId, { model: "test-model-default", fail: true })).status).toBe(
      529,
    );
    expect(main.seen).toHaveLength(1);
    expect(local.seen).toEqual([]);
  });
});

describe("admission precedes routing", () => {
  it("a 402 budget refusal asks no upstream", async () => {
    const app = Fastify();
    const upstreamFor = vi.fn(() => ({ id: "default", baseUrl: "http://127.0.0.1:1" }));
    const fetchImpl = vi.fn<typeof fetch>();
    const tokens = {
      verify: () => ({ runId: "run_1" }),
    } as unknown as RunTokenStore;
    registerModelProxy(app, {
      tokens,
      upstreamFor,
      fetchImpl,
      frozenModels: () => ({ model: "m", cheapModel: "c" }),
      admit: () => ({ message: "spent", details: {} }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      payload: JSON.stringify({ model: "m" }),
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().code).toBe("budget_exhausted");
    expect(upstreamFor).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("a zero price is a known price (ADR-0039 decision 5)", () => {
  it("prices to 0, never null", () => {
    const usage = { inputTokens: 10, outputTokens: 10, cacheReadTokens: 5, cacheCreateTokens: 5 };
    expect(priceUsage([price("local-27b", 0)], "local-27b", usage, "2026-10-14T00:00:00Z")).toBe(0);
    expect(priceUsage([], "local-27b", usage, "2026-10-14T00:00:00Z")).toBeNull();
  });
});
