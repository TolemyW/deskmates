// T1: the usage summary is written when an attempt ends (ADR-0032 amendment 1 decision 12),
// through the real Gateway lifecycle with an in-process provider; no model or Docker.

import { isTerminal } from "@deskmates/contracts";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";
import { RunUsageSummaryStore } from "./run-usage-summaries.js";

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

it("stores the run's per-model summary at the end of the attempt, before any Costs read", async () => {
  const { thread } = await h.seed();
  const ctx = h.app.deskmates.ctx;
  h.provider.onRun(async (req, gw) => {
    await gw.post("ended", {
      type: "run_ended",
      runId: req.runId,
      outcome: "completed",
      usage: [
        {
          model: "model-a",
          inputTokens: 120,
          outputTokens: 30,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
        },
      ],
      summary: {
        done: "handled",
        reply: "done",
        filesChanged: [],
        sitesVisited: [],
        pendingApprovals: [],
        memorySuggestions: [],
      },
    });
  });
  await h.api("POST", `/api/threads/${thread.id}/messages`, { body: "hello" });
  await waitFor(() => {
    const runs = ctx.runs.list({ threadId: thread.id });
    return runs.length > 0 && runs.every((r) => isTerminal(r.status));
  });
  const [run] = ctx.runs.list({ threadId: thread.id });
  if (!run) throw new Error("no run");
  const summary = new RunUsageSummaryStore(ctx.db).get(run.id);
  expect(summary?.models).toEqual([
    expect.objectContaining({
      model: "model-a",
      usageCount: 1,
      inputTokens: 120,
      outputTokens: 30,
    }),
  ]);
});
