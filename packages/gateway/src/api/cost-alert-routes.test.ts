// T1: cost alerts end to end (ADR-0018 decisions 2, 4 and 5). A run ends with usage through the
// sidecar protocol, the rule fires once, and the alert row, the `cost_alert` run event, the SSE
// frame and `GET /api/costs` all say the same number. Nothing about the run changes.

import type {
  CostAlert,
  CostAlertRule,
  CostReport,
  Run,
  RunEvent,
  ThreadMessage,
} from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunRecord } from "../ledger/runs.js";
import type { SidecarScript } from "../test-support/fake-provider.js";
import { type Harness, openSse, startHarness, waitFor } from "../test-support/harness.js";

const MODEL = "model-a";

function finish(inputTokens: number): SidecarScript {
  return async (req, gw) => {
    await gw.post("ended", {
      type: "run_ended",
      runId: req.runId,
      outcome: "completed",
      usage: [
        { model: MODEL, inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
      ],
      summary: {
        done: "answered",
        filesChanged: [],
        sitesVisited: [],
        pendingApprovals: [],
        memorySuggestions: [],
        reply: "done",
      },
    });
    return undefined;
  };
}

let h: Harness;

beforeEach(async () => {
  // $10 per million input tokens: 100 input tokens cost $0.001.
  h = await startHarness({
    modelPrices: [
      {
        model: MODEL,
        inputPerM: 10,
        outputPerM: 0,
        cacheReadPerM: 0,
        cacheCreatePerM: 0,
        effectiveFrom: "2020-01-01T00:00:00.000Z",
      },
    ],
  });
});

afterEach(async () => {
  await h.close();
});

async function runOnce(
  threadId: string,
  inputTokens: number,
): Promise<{ run: RunRecord; message: ThreadMessage }> {
  h.provider.onRun(finish(inputTokens));
  const posted = await h.api<{ message: ThreadMessage; runs: Run[] }>(
    "POST",
    `/api/threads/${threadId}/messages`,
    { body: "hello" },
  );
  expect(posted.status).toBe(201);
  const runId = posted.json.runs[0]?.id;
  if (!runId) throw new Error("no run created");
  await waitFor(
    () => h.app.deskmates.ctx.runs.mustGet(runId).status === "succeeded",
    5000,
    "the run to succeed",
  );
  await h.app.deskmates.scheduler.drain();
  return { run: h.app.deskmates.ctx.runs.mustGet(runId), message: posted.json.message };
}

describe("cost alert routes", () => {
  it("validates and lists rules behind the operator credential", async () => {
    const { bot } = await h.seed();
    const bad = [
      { kind: "known_cost", window: "day" },
      { kind: "known_cost", window: "day", thresholdUsd: -1 },
      { kind: "known_cost", window: "day", thresholdUsd: "1" },
      { kind: "known_cost", window: "week", thresholdUsd: 1 },
      { kind: "budget", window: "day", thresholdUsd: 1 },
      { kind: "unpriced_usage", window: "day", thresholdUsd: 1 },
    ];
    for (const body of bad) {
      const res = await h.api<{ code: string }>("POST", "/api/cost-alert-rules", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.json.code).toBe("validation");
    }
    const unknownBot = await h.api<{ code: string }>("POST", "/api/cost-alert-rules", {
      kind: "known_cost",
      window: "day",
      thresholdUsd: 1,
      botId: "bot_missing",
    });
    expect(unknownBot.status).toBe(404);

    const created = await h.api<{ rule: CostAlertRule }>("POST", "/api/cost-alert-rules", {
      kind: "known_cost",
      window: "month",
      thresholdUsd: 2.5,
      botId: bot.id,
      authorId: "ops",
    });
    expect(created.status).toBe(201);
    expect(created.json.rule).toMatchObject({
      kind: "known_cost",
      window: "month",
      thresholdUsd: 2.5,
      botId: bot.id,
      createdBy: "human:ops",
    });
    const listed = await h.api<{ rules: CostAlertRule[] }>("GET", "/api/cost-alert-rules");
    expect(listed.json.rules.map((r) => r.id)).toEqual([created.json.rule.id]);
    const deleted = await h.api<{ deleted: boolean }>(
      "DELETE",
      `/api/cost-alert-rules/${created.json.rule.id}`,
    );
    expect(deleted.json.deleted).toBe(true);
    const gone = await h.api<{ code: string }>(
      "DELETE",
      `/api/cost-alert-rules/${created.json.rule.id}`,
    );
    expect(gone.status).toBe(404);
    const badStatus = await h.api<{ code: string }>("GET", "/api/cost-alerts?status=closed");
    expect(badStatus.status).toBe(400);
  });

  it("fires once when a run's usage crosses the line and agrees with the cost report", async () => {
    const { thread, bot } = await h.seed();
    await h.api("POST", "/api/cost-alert-rules", {
      kind: "known_cost",
      window: "day",
      thresholdUsd: 0.0015,
    });
    const sse = await openSse(h.baseUrl);
    try {
      // 100 tokens = $0.001: below the line, no alert.
      const first = await runOnce(thread.id, 100);
      expect(await h.api<{ alerts: CostAlert[] }>("GET", "/api/cost-alerts")).toMatchObject({
        json: { alerts: [] },
      });
      expect(first.run.status).toBe("succeeded");

      // Another 100 tokens: $0.002 in the day, the rule fires on this run.
      const second = await runOnce(thread.id, 100);
      const open = await h.api<{ alerts: CostAlert[] }>("GET", "/api/cost-alerts");
      expect(open.json.alerts).toHaveLength(1);
      const alert = open.json.alerts[0] as CostAlert;
      expect(alert).toMatchObject({
        kind: "known_cost",
        window: "day",
        thresholdUsd: 0.0015,
        runId: second.run.id,
        totals: { knownCostUsd: 0.002, runCount: 2, usageCount: 2, unpricedUsageCount: 0 },
      });
      expect(alert.windowKey).toBe(new Date().toISOString().slice(0, 10));

      const report = await h.api<CostReport>(
        "GET",
        `/api/costs?from=${alert.windowKey}&to=${alert.windowKey}`,
      );
      expect(report.json.totals.knownCostUsd).toBe(alert.totals.knownCostUsd);
      expect(report.json.totals.unpricedUsageCount).toBe(alert.totals.unpricedUsageCount);

      const events = await h.api<{ events: RunEvent[] }>(
        "GET",
        `/api/runs/${second.run.id}/events`,
      );
      const costEvents = events.json.events.filter((e) => e.kind === "cost_alert");
      expect(costEvents).toHaveLength(1);
      expect(costEvents[0]?.payload).toMatchObject({
        alertId: alert.id,
        knownCostUsd: 0.002,
        unpricedUsageCount: 0,
        thresholdUsd: 0.0015,
      });
      const firstEvents = await h.api<{ events: RunEvent[] }>(
        "GET",
        `/api/runs/${first.run.id}/events`,
      );
      expect(firstEvents.json.events.some((e) => e.kind === "cost_alert")).toBe(false);

      await waitFor(
        () => sse.events.some((e) => e.type === "cost_alert" && e.alert.id === alert.id),
        3000,
        "the cost_alert SSE frame",
      );
      expect(sse.events.filter((e) => e.type === "cost_alert")).toHaveLength(1);

      // A third run in the same window: the run is unaffected and nothing fires again.
      const third = await runOnce(thread.id, 100);
      expect(third.run.status).toBe("succeeded");
      expect(
        (await h.api<{ alerts: CostAlert[] }>("GET", "/api/cost-alerts")).json.alerts,
      ).toHaveLength(1);
      expect(sse.events.filter((e) => e.type === "cost_alert")).toHaveLength(1);

      // The alert is not a run knob: the run's recorded configuration carries no alert field.
      expect(Object.keys(third.run.config).some((k) => /alert/i.test(k))).toBe(false);
      expect(bot.id).toBe(third.run.botId);

      const acked = await h.api<{ alert: CostAlert }>(
        "POST",
        `/api/cost-alerts/${alert.id}/acknowledge`,
        { authorId: "ops" },
      );
      expect(acked.json.alert.acknowledgedBy).toBe("human:ops");
      expect((await h.api<{ alerts: CostAlert[] }>("GET", "/api/cost-alerts")).json.alerts).toEqual(
        [],
      );
      expect(
        (await h.api<{ alerts: CostAlert[] }>("GET", "/api/cost-alerts?status=acknowledged")).json
          .alerts,
      ).toHaveLength(1);
    } finally {
      sse.close();
    }
  });

  it("surfaces unpriced usage without counting it as zero", async () => {
    const { thread } = await h.seed();
    await h.api("POST", "/api/cost-alert-rules", { kind: "unpriced_usage", window: "month" });
    h.provider.onRun(async (req, gw) => {
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        usage: [
          {
            model: "model-nobody-priced",
            inputTokens: 5,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheCreateTokens: 0,
          },
        ],
        summary: {
          done: "x",
          filesChanged: [],
          sitesVisited: [],
          pendingApprovals: [],
          memorySuggestions: [],
          reply: "ok",
        },
      });
      return undefined;
    });
    const posted = await h.api<{ runs: Run[] }>("POST", `/api/threads/${thread.id}/messages`, {
      body: "hi",
    });
    const runId = posted.json.runs[0]?.id as string;
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(runId as Run["id"]).status === "succeeded",
    );
    await h.app.deskmates.scheduler.drain();
    const open = await h.api<{ alerts: CostAlert[] }>("GET", "/api/cost-alerts");
    expect(open.json.alerts).toHaveLength(1);
    expect(open.json.alerts[0]?.totals).toMatchObject({
      knownCostUsd: null,
      unpricedUsageCount: 1,
      costStatus: "unpriced",
    });
    expect(open.json.alerts[0]?.thresholdUsd).toBeUndefined();
  });

  it("fires nothing for a run that ends without usage or for a price table change", async () => {
    const { thread } = await h.seed();
    await h.api("POST", "/api/cost-alert-rules", { kind: "unpriced_usage", window: "day" });
    await h.api("POST", "/api/cost-alert-rules", {
      kind: "known_cost",
      window: "day",
      thresholdUsd: 0.0000001,
    });
    h.provider.onRun(async (req, gw) => {
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        usage: [],
        summary: {
          done: "x",
          filesChanged: [],
          sitesVisited: [],
          pendingApprovals: [],
          memorySuggestions: [],
          reply: "ok",
        },
      });
      return undefined;
    });
    const posted = await h.api<{ runs: Run[] }>("POST", `/api/threads/${thread.id}/messages`, {
      body: "hi",
    });
    const runId = posted.json.runs[0]?.id as string;
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(runId as Run["id"]).status === "succeeded",
    );
    await h.app.deskmates.scheduler.drain();
    const prices = await h.api("PUT", "/api/prices", {
      prices: [
        { model: "model-z", inputPerM: 1, outputPerM: 1, cacheReadPerM: 0, cacheCreatePerM: 0 },
      ],
    });
    expect(prices.status).toBe(200);
    expect(
      (await h.api<{ alerts: CostAlert[] }>("GET", "/api/cost-alerts?status=all")).json.alerts,
    ).toEqual([]);
  });
});
