// T1: the operator price table. The Gateway prices tokens itself (AGENTS.md, ADR-0002 item 5):
// rows come from `MODEL_PRICES` at startup or from `PUT /api/prices`, and a model with no row
// stays unpriced with a `pricing_missing` event rather than being billed at zero.

import type { ModelPrice, RunEvent, RunUsage } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { RunRecord } from "../ledger/runs.js";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";

const DEFAULT_MODEL = "test-model-default";

function price(model: string, inputPerM: number): ModelPrice {
  return {
    model,
    inputPerM,
    outputPerM: inputPerM * 5,
    cacheReadPerM: 0.1,
    cacheCreatePerM: 0.2,
    effectiveFrom: "1970-01-01T00:00:00.000Z",
  };
}

let h: Harness;

afterEach(async () => {
  await h.close();
});

/** One run that reports usage on the default model; resolves with the finished run's id. */
async function runWithUsage(): Promise<string> {
  const { thread } = await h.seed();
  h.provider.onRun(async (req, gw) => {
    await gw.post("ended", {
      type: "run_ended",
      runId: req.runId,
      outcome: "completed",
      summary: {
        done: "answered",
        filesChanged: [],
        sitesVisited: [],
        pendingApprovals: [],
        memorySuggestions: [],
        reply: "ok",
      },
      usage: [
        {
          model: req.model,
          inputTokens: 1_000_000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
        },
      ],
    });
  });
  const posted = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${thread.id}/messages`, {
    body: "x",
  });
  const run = posted.json.runs[0] as RunRecord;
  await waitFor(() => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded", 3000, "run");
  return run.id;
}

describe("price table", () => {
  it("prices a run from MODEL_PRICES loaded at startup, with no pricing_missing event", async () => {
    h = await startHarness({ modelPrices: [price(DEFAULT_MODEL, 3)] });
    const runId = await runWithUsage();

    const view = await h.api<{ usage: RunUsage[] }>("GET", `/api/runs/${runId}`);
    expect(view.json.usage[0]?.costUsd).toBe(3);
    const events = await h.api<{ events: RunEvent[] }>("GET", `/api/runs/${runId}/events`);
    expect(events.json.events.filter((e) => e.kind === "pricing_missing")).toEqual([]);
  });

  it("leaves an unknown model unpriced and says so in the ledger", async () => {
    h = await startHarness();
    const runId = await runWithUsage();

    const view = await h.api<{ usage: RunUsage[] }>("GET", `/api/runs/${runId}`);
    expect(view.json.usage[0]?.costUsd).toBeNull();
    const events = await h.api<{ events: RunEvent[] }>("GET", `/api/runs/${runId}/events`);
    const missing = events.json.events.filter((e) => e.kind === "pricing_missing");
    expect(missing).toHaveLength(1);
    expect(missing[0]?.payload).toMatchObject({ model: DEFAULT_MODEL });
  });

  it("GET lists every row ordered by model then effective date", async () => {
    h = await startHarness({
      modelPrices: [
        { ...price("test-model-z", 1) },
        { ...price("test-model-a", 2), effectiveFrom: "2026-01-01T00:00:00.000Z" },
        { ...price("test-model-a", 1) },
      ],
    });
    const res = await h.api<{ prices: ModelPrice[] }>("GET", "/api/prices");
    expect(res.status).toBe(200);
    expect(res.json.prices.map((p) => [p.model, p.effectiveFrom])).toEqual([
      ["test-model-a", "1970-01-01T00:00:00.000Z"],
      ["test-model-a", "2026-01-01T00:00:00.000Z"],
      ["test-model-z", "1970-01-01T00:00:00.000Z"],
    ]);
  });

  it("PUT upserts rows and the next run is priced by them", async () => {
    h = await startHarness();
    const put = await h.api<{ prices: ModelPrice[] }>("PUT", "/api/prices", {
      prices: [
        {
          model: DEFAULT_MODEL,
          inputPerM: 2,
          outputPerM: 10,
          cacheReadPerM: 0,
          cacheCreatePerM: 0,
        },
      ],
    });
    expect(put.status).toBe(200);
    // `effectiveFrom` defaults to the epoch, so the row prices everything that came before it.
    expect(put.json.prices[0]?.effectiveFrom).toBe("1970-01-01T00:00:00.000Z");

    const runId = await runWithUsage();
    const view = await h.api<{ usage: RunUsage[] }>("GET", `/api/runs/${runId}`);
    expect(view.json.usage[0]?.costUsd).toBe(2);
  });

  it("rejects a malformed price row", async () => {
    h = await startHarness();
    for (const bad of [
      { prices: "no" },
      {
        prices: [{ model: "", inputPerM: 1, outputPerM: 1, cacheReadPerM: 1, cacheCreatePerM: 1 }],
      },
      {
        prices: [
          { model: "m", inputPerM: -1, outputPerM: 1, cacheReadPerM: 1, cacheCreatePerM: 1 },
        ],
      },
      {
        prices: [
          {
            model: "m",
            inputPerM: 1,
            outputPerM: 1,
            cacheReadPerM: 1,
            cacheCreatePerM: 1,
            effectiveFrom: "yesterday",
          },
        ],
      },
    ]) {
      const res = await h.api<{ code: string }>("PUT", "/api/prices", bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.json.code).toBe("validation");
    }
  });
});
