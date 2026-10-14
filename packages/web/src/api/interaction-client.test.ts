import { describe, expect, it } from "vitest";
import { BOT_ID, RUN_ID, THREAD_ID, WS_ID, bot, fakeFetch, run } from "../test-support/fixtures.js";
import { createApiClient } from "./client.js";

describe("interaction API client", () => {
  it("keeps a continuation on the same run and fetches its context metrics", async () => {
    const metrics = {
      turns: 0,
      peakInputTokens: null,
      p95InputTokens: null,
      cacheHitRatio: null,
      compactions: [],
      contextSections: null,
      systemPromptSha256: null,
      modelRequests: { count: 0, distinctSystemHashes: 0, changedWithinAttempt: false },
    };
    const { fetch, calls } = fakeFetch({
      "GET /api/runs/run_1/context": metrics,
      "POST /api/runs/run_1/continuation/decide": { run: run() },
    });
    const api = createApiClient({ fetch });
    expect(await api.getRunContext(RUN_ID)).toEqual(metrics);
    expect(await api.decideContinuation(RUN_ID, "continue")).toEqual({ run: run() });
    expect(calls[1]?.body).toEqual({ decision: "continue" });
  });

  it("uses explicit closure and consolidation actions without sending a chat message", async () => {
    const closed = { episode: null, distilled: [] };
    const { fetch, calls } = fakeFetch({
      "POST /api/threads/thr_1/close-task": closed,
      "POST /api/bots/bot_1/memory/consolidate": { run: run() },
      "GET /api/workspaces/ws_1/memory/search?q=old+facts&scope=workspace": { entries: [] },
    });
    const api = createApiClient({ fetch });
    expect(await api.closeThreadTask(THREAD_ID)).toEqual(closed);
    expect(await api.consolidateBotMemory(BOT_ID)).toEqual({ run: run() });
    expect(await api.searchLearnedMemory(WS_ID, "old facts", "workspace")).toEqual([]);
    expect(calls).toHaveLength(3);
  });

  it("allows clearing schedules without changing model overrides", async () => {
    const { fetch, calls } = fakeFetch({ "PATCH /api/bots/bot_1": { bot } });
    await createApiClient({ fetch }).updateBot(BOT_ID, { cron: [] });
    expect(calls[0]?.body).toEqual({ cron: [] });
  });
});
