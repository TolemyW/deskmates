// T1: `GET /api/runs/:id/context`, the per-run context metrics on the operator API (M3 context
// plan, Phase 1). Run tokens cannot reach it: `operator-auth.test.ts`.

import type { RunId } from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunContextMetrics } from "../ledger/run-context.js";
import { type Harness, startHarness } from "../test-support/harness.js";

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
  h.app.deskmates.scheduler.stop();
});

afterEach(async () => {
  await h.close();
});

describe("GET /api/runs/:id/context", () => {
  it("computes the metrics from the run's events and model requests", async () => {
    const { bot } = await h.seed();
    const ctx = h.app.deskmates.ctx;
    const run = ctx.runs.create({
      botId: bot.id,
      lane: "background",
      triggerKind: "webhook",
      triggerRef: "ctx",
      triggerPayload: { body: "x" },
      config: ctx.runConfig(),
    });
    ctx.events.appendMany([
      {
        runId: run.id,
        kind: "log",
        attempt: 1,
        seq: 1,
        payload: {
          source: "context",
          kind: "context_sections",
          sections: { soul: 12, memory: 0, diary: 40, knowledge: 0, guidance: 900 },
          systemPromptSha256: "c".repeat(64),
        },
      },
      {
        runId: run.id,
        kind: "turn_usage",
        attempt: 1,
        seq: 2,
        payload: {
          model: "m",
          turn: 1,
          inputTokens: 1000,
          outputTokens: 10,
          cacheReadTokens: 3000,
          cacheCreateTokens: 0,
        },
      },
      {
        runId: run.id,
        kind: "compact_boundary",
        attempt: 1,
        seq: 3,
        payload: { trigger: "auto", preTokens: 150000 },
      },
    ]);
    ctx.modelRequests.insert({
      runId: run.id,
      attempt: 1,
      ts: "t",
      requestKind: "messages",
      systemSha256: "d".repeat(64),
      stream: true,
    });

    const res = await h.api<RunContextMetrics>("GET", `/api/runs/${run.id}/context`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      turns: 1,
      peakInputTokens: 4000,
      p95InputTokens: 4000,
      cacheHitRatio: 0.75,
      compactions: [{ attempt: 1, seq: 3, trigger: "auto", preTokens: 150000 }],
      contextSections: { soul: 12, memory: 0, diary: 40, knowledge: 0, guidance: 900 },
      systemPromptSha256: "c".repeat(64),
      maxContextTokens: null,
      systemPromptStaticSha256: null,
      systemPromptDynamicSha256: null,
      modelRequests: { count: 1, distinctSystemHashes: 1, changedWithinAttempt: false },
      contextUsage: { samples: 0, first: null, latest: null },
      sessionStarts: [],
      requestShapes: null,
    });
  });

  // ADR-0023 amendment 5: the CLI's context samples and the proxy's request shapes.
  it("adds the context samples, session starts and request shapes", async () => {
    const { bot } = await h.seed();
    const ctx = h.app.deskmates.ctx;
    const run = ctx.runs.create({
      botId: bot.id,
      lane: "background",
      triggerKind: "webhook",
      triggerRef: "ctx-shape",
      triggerPayload: { body: "x" },
      config: ctx.runConfig(),
    });
    ctx.events.appendMany([
      {
        runId: run.id,
        kind: "log",
        attempt: 1,
        seq: 1,
        payload: { source: "sdk", kind: "session_start", sessionSource: "startup" },
      },
      {
        runId: run.id,
        kind: "log",
        attempt: 1,
        seq: 2,
        payload: {
          source: "context",
          kind: "context_usage",
          detail: "full",
          turn: 0,
          totalTokens: 57000,
          maxTokens: 200000,
          percentage: 29,
          categories: [{ name: "System tools", kind: "used", tokens: 21000 }],
        },
      },
    ]);
    ctx.modelRequests.insert({
      runId: run.id,
      attempt: 1,
      ts: "t",
      requestKind: "messages",
      stream: true,
      shape: {
        cacheControlBlocks: 2,
        systemBlocks: 2,
        systemChars: 9000,
        systemStaticSha256: "e".repeat(64),
        systemBlockHashes: ["0123456789abcdef", "fedcba9876543210"],
        toolsCount: 54,
        toolsChars: 160000,
        messagesCount: 1,
      },
    });

    const res = await h.api<RunContextMetrics>("GET", `/api/runs/${run.id}/context`);
    expect(res.status).toBe(200);
    expect(res.json.sessionStarts).toEqual([
      { attempt: 1, source: "startup", contextTokens: null, promptCacheLikelyExpired: null },
    ]);
    expect(res.json.contextUsage?.first?.totalTokens).toBe(57000);
    expect(res.json.requestShapes).toMatchObject({
      measured: 1,
      withCacheControl: 1,
      distinctStaticHashes: 1,
      maxToolsCount: 54,
    });
  });

  it("answers 404 for an unknown run", async () => {
    const res = await h.api("GET", `/api/runs/${"run_missing" as RunId}/context`);
    expect(res.status).toBe(404);
  });
});
