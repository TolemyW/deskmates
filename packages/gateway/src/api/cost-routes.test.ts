import type { CostRankingPage, CostReport, CostRowPage } from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "../test-support/harness.js";

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

describe("GET /api/costs", () => {
  it("returns the authenticated grouped report with filters echoed", async () => {
    const { bot } = await h.seed();
    h.app.deskmates.ctx.db
      .prepare(
        `INSERT INTO runs
           (workspace_id, id, bot_id, lane, status, trigger_kind, trigger_ref, created_at)
         VALUES ((SELECT workspace_id FROM bots WHERE id = ?), 'run-cost', ?, 'interactive', 'succeeded', 'thread_message', 'message',
                 '2026-09-23T10:00:00.000Z')`,
      )
      .run(bot.id, bot.id);
    h.app.deskmates.ctx.db
      .prepare(
        `INSERT INTO run_usage
           (run_id, attempt, model, input_tokens, output_tokens,
            cache_read_tokens, cache_create_tokens, cost_usd)
         VALUES ('run-cost', 1, 'model-a', 10, 20, 30, 40, NULL)`,
      )
      .run();

    const response = await h.api<CostReport>(
      "GET",
      `/api/costs?from=2026-09-23&to=2026-09-23&botId=${bot.id}&model=model-a`,
    );

    expect(response.status).toBe(200);
    expect(response.json.filters).toEqual({
      from: "2026-09-23",
      to: "2026-09-23",
      botId: bot.id,
      model: "model-a",
    });
    // The summary carries totals and days, never rows; the rows come a page at a time (#113).
    expect(response.json.rows).toBeUndefined();
    expect(response.json.totals).toMatchObject({ inputTokens: 10, usageCount: 1 });
    const rows = await h.api<CostRowPage>(
      "GET",
      `/api/costs/rows?from=2026-09-23&to=2026-09-23&botId=${bot.id}&model=model-a`,
    );
    expect(rows.json).toMatchObject({ total: 1 });
    expect(rows.json.nextCursor).toBeUndefined();
    expect(rows.json.rows[0]).toMatchObject({
      day: "2026-09-23",
      botId: bot.id,
      botName: bot.name,
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreateTokens: 40,
      knownCostUsd: null,
      costStatus: "unpriced",
    });
  });

  it("rejects malformed, impossible and reversed date ranges", async () => {
    for (const path of [
      "/api/costs?from=09-23-2026",
      "/api/costs?to=2026-02-30",
      "/api/costs?from=2026-09-24&to=2026-09-23",
      "/api/costs?model=%20",
    ]) {
      const response = await h.api<{ code: string }>("GET", path);
      expect(response.status, path).toBe(400);
      expect(response.json.code, path).toBe("validation");
    }
  });
});

describe("estimates and rankings (ADR-0032 decisions 4 and 9)", () => {
  function seedWorld(): void {
    const db = h.app.deskmates.ctx.db;
    const ws = (id: string, name: string) =>
      db
        .prepare(
          `INSERT INTO workspaces (id, tenant_id, name, sandbox_provider, status, created_at)
           VALUES (?, 'tnt_default', ?, 'docker', 'ready', '2026-09-01T00:00:00.000Z')`,
        )
        .run(id, name);
    ws("ws_a", "Research");
    ws("ws_b", "Support");
    // Two bots with the same name in two workspaces.
    db.prepare(
      `INSERT INTO bots (id, workspace_id, name, role, created_at) VALUES
         ('bot_a', 'ws_a', 'Scout', '', '2026-09-01T00:00:00.000Z'),
         ('bot_b', 'ws_b', 'Scout', '', '2026-09-01T00:00:00.000Z')`,
    ).run();
    for (const [model, perM] of [
      ["model-a", 1],
      ["model-b", 3],
    ] as const)
      db.prepare(
        `INSERT INTO prices (model, input_per_m, output_per_m, cache_read_per_m, cache_create_per_m, effective_from)
         VALUES (?, ?, 0, 0, 0, '2020-01-01T00:00:00.000Z')`,
      ).run(model, perM);
    let n = 0;
    const usage = (ws: string, bot: string, model: string, input: number, cost: number | null) => {
      n += 1;
      const id = `run_${n}`;
      db.prepare(
        `INSERT INTO runs (workspace_id, id, bot_id, lane, status, trigger_kind, trigger_ref, created_at, started_at)
         VALUES (?, ?, ?, 'interactive', 'succeeded', 'thread_message', ?, '2026-10-01T10:00:00.000Z', '2026-10-01T10:00:00.000Z')`,
      ).run(ws, id, bot, id);
      db.prepare(
        `INSERT INTO run_usage (run_id, attempt, model, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, cost_usd)
         VALUES (?, 1, ?, ?, 0, 0, 0, ?)`,
      ).run(id, model, input, cost);
    };
    usage("ws_a", "bot_a", "model-a", 1_000_000, 1);
    // Unpriced: estimated at the mean input price ($2/M), never added to the known cost.
    usage("ws_b", "bot_b", "model-x", 2_000_000, null);
    // Eleven more unpriced models with small usage, to need a second ranking page.
    for (let i = 0; i < 11; i++) usage("ws_a", "bot_a", `model-z${i}`, 1000 + i, null);
  }

  it("reports known and estimated cost apart and labels same-name bots by workspace", async () => {
    seedWorld();
    const report = (await h.api<CostReport>("GET", "/api/costs?workspaceId=ws_b")).json;
    expect(report.totals).toMatchObject({
      knownCostUsd: null,
      estimatedCostUsd: 4,
      estimatedUsageCount: 1,
      unpricedUsageCount: 1,
      costStatus: "unpriced",
    });
    expect(report.estimate).toEqual({ version: "avg-unit-price-v1" });
    expect(report.days).toEqual([
      expect.objectContaining({ day: "2026-10-01", estimatedCostUsd: 4 }),
    ]);
    const bots = (await h.api<CostRankingPage>("GET", "/api/costs/ranking?by=bot&metric=money"))
      .json;
    expect(bots.entries.map((e) => [e.label, e.workspaceName])).toEqual([
      ["Scout", "Support"],
      ["Scout", "Research"],
    ]);
  });

  it("ranks the whole range ten a page without changing the totals", async () => {
    seedWorld();
    const full = (await h.api<CostReport>("GET", "/api/costs")).json;
    const first = (await h.api<CostRankingPage>("GET", "/api/costs/ranking?by=model&metric=money"))
      .json;
    expect(first.total).toBe(13);
    expect(first.entries).toHaveLength(10);
    expect(first.entries[0]).toMatchObject({ key: "model-x", estimatedCostUsd: 4 });
    expect(first.entries[1]).toMatchObject({ key: "model-a", knownCostUsd: 1 });
    const second = (
      await h.api<CostRankingPage>("GET", "/api/costs/ranking?by=model&metric=usage&offset=10")
    ).json;
    expect(second.entries).toHaveLength(3);
    expect(second.total).toBe(13);
    // Usage ranks tokens: the smallest model last.
    expect(second.entries.at(-1)?.key).toBe("model-z0");
    const again = (await h.api<CostReport>("GET", "/api/costs")).json;
    expect(again.totals).toEqual(full.totals);
    for (const path of [
      "/api/costs/ranking?by=day",
      "/api/costs/ranking?metric=tokens",
      "/api/costs/ranking?offset=-1",
    ])
      expect((await h.api("GET", path)).status, path).toBe(400);
  });
});
