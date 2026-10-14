// T1: the Costs lists page on the server (#113, pagination coverage surfaces 2 to 6). Activity rows
// and fired alerts are keyset pages, rankings and alert rules offset pages; a limit over the
// maximum, a malformed cursor or one from another filter is 400; equal sort keys fall back to a
// unique tie-breaker; and totals stay the summary's, whatever page is read.

import type {
  CostAlertPage,
  CostAlertRulePage,
  CostRankingPage,
  CostReport,
  CostRowPage,
} from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "../test-support/harness.js";

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

const db = () => h.app.deskmates.ctx.db;

/** Two workspaces; a bot named alike in each, so the bot id breaks the tie. */
function seedWorld(): void {
  const ws = (id: string, name: string) =>
    db()
      .prepare(
        `INSERT INTO workspaces (id, tenant_id, name, sandbox_provider, status, created_at)
         VALUES (?, 'tnt_default', ?, 'docker', 'ready', '2026-09-01T00:00:00.000Z')`,
      )
      .run(id, name);
  ws("ws_a", "Research");
  ws("ws_b", "Support");
  db()
    .prepare(
      `INSERT INTO bots (id, workspace_id, name, role, created_at) VALUES
         ('bot_b', 'ws_b', 'Scout', '', '2026-09-01T00:00:00.000Z'),
         ('bot_a', 'ws_a', 'Scout', '', '2026-09-01T00:00:00.000Z'),
         ('bot_c', 'ws_b', 'Helper', '', '2026-09-01T00:00:00.000Z')`,
    )
    .run();
}

let runs = 0;
function usage(bot: string, day: string, model: string, input: number, cost: number | null) {
  runs += 1;
  const id = `run_${runs}`;
  db()
    .prepare(
      `INSERT INTO runs (workspace_id, id, bot_id, lane, status, trigger_kind, trigger_ref, created_at, started_at)
       VALUES ((SELECT workspace_id FROM bots WHERE id = ?), ?, ?, 'interactive', 'succeeded',
               'thread_message', ?, ?, ?)`,
    )
    .run(bot, id, bot, id, `${day}T10:00:00.000Z`, `${day}T10:00:00.000Z`);
  db()
    .prepare(
      `INSERT INTO run_usage (run_id, attempt, model, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, cost_usd)
       VALUES (?, 1, ?, ?, 0, 0, 0, ?)`,
    )
    .run(id, model, input, cost);
  return id;
}

describe("Costs pages (#113)", () => {
  it("pages Activity rows by keyset in Activity order while the summary keeps the totals", async () => {
    seedWorld();
    usage("bot_a", "2026-10-02", "model-a", 10, 1);
    usage("bot_b", "2026-10-02", "model-a", 20, 2);
    usage("bot_a", "2026-10-02", "model-b", 30, null);
    usage("bot_c", "2026-10-01", "model-a", 40, 4);
    usage("bot_a", "2026-10-01", "model-a", 50, 5);
    const summary = (await h.api<CostReport>("GET", "/api/costs")).json;
    expect(summary.rows).toBeUndefined();
    expect(summary.totals).toMatchObject({ inputTokens: 150, usageCount: 5 });

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const query: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const page: CostRowPage = (await h.api<CostRowPage>("GET", `/api/costs/rows?limit=2${query}`))
        .json;
      expect(page.total).toBe(5);
      seen.push(...page.rows.map((row) => `${row.day} ${row.botName} ${row.botId} ${row.model}`));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    // Newest day first; then bot name (Helper before Scout), bot id, model.
    expect(seen).toEqual([
      "2026-10-02 Scout bot_a model-a",
      "2026-10-02 Scout bot_a model-b",
      "2026-10-02 Scout bot_b model-a",
      "2026-10-01 Helper bot_c model-a",
      "2026-10-01 Scout bot_a model-a",
    ]);
    // The rows of every page add up to the summary, which no page changes.
    const all = (await h.api<CostRowPage>("GET", "/api/costs/rows?limit=100")).json;
    expect(all.rows.reduce((n, row) => n + row.inputTokens, 0)).toBe(summary.totals.inputTokens);
    expect(all.nextCursor).toBeUndefined();

    const first = (await h.api<CostRowPage>("GET", "/api/costs/rows?limit=2")).json;
    expect((await h.api("GET", "/api/costs/rows?limit=101")).status).toBe(400);
    expect((await h.api("GET", "/api/costs/rows?cursor=bm9wZQ")).status).toBe(400);
    // A cursor of one filter is refused under another.
    const foreign = encodeURIComponent(first.nextCursor ?? "");
    expect(
      (await h.api("GET", `/api/costs/rows?limit=2&model=model-a&cursor=${foreign}`)).status,
    ).toBe(400);
    const empty = (await h.api<CostRowPage>("GET", "/api/costs/rows?model=missing")).json;
    expect(empty).toMatchObject({ rows: [], total: 0 });
  });

  it("pages a ranking with a chosen limit and refuses one over the maximum", async () => {
    seedWorld();
    for (let i = 0; i < 5; i += 1) usage("bot_a", "2026-10-01", `model-${i}`, 100 - i, null);
    const seen: string[] = [];
    for (const offset of [0, 2, 4]) {
      const page = (
        await h.api<CostRankingPage>(
          "GET",
          `/api/costs/ranking?by=model&metric=usage&offset=${offset}&limit=2`,
        )
      ).json;
      expect(page).toMatchObject({ offset, limit: 2, total: 5 });
      seen.push(...page.entries.map((entry) => entry.key));
    }
    expect(seen).toEqual(["model-0", "model-1", "model-2", "model-3", "model-4"]);
    expect((await h.api<CostRankingPage>("GET", "/api/costs/ranking")).json.limit).toBe(10);
    expect((await h.api("GET", "/api/costs/ranking?limit=101")).status).toBe(400);
    expect((await h.api("GET", "/api/costs/ranking?offset=-1")).status).toBe(400);
  });

  it("pages open alerts newest first with the id as tie-breaker and the open count as total", async () => {
    seedWorld();
    const run = usage("bot_a", "2026-10-01", "model-a", 1, 1);
    const alert = (id: string, firedAt: string, acknowledged = false) => {
      db()
        .prepare(
          `INSERT INTO cost_alert_rules (id, workspace_id, kind, window_kind, created_by, created_at)
           VALUES (?, 'ws_a', 'unpriced_usage', 'day', 'human:test', ?)`,
        )
        .run(`rule_${id}`, firedAt);
      db()
        .prepare(
          `INSERT INTO cost_alerts (id, workspace_id, rule_id, kind, window_kind, window_key, run_id,
             run_count, usage_count, input_tokens, output_tokens, cache_read_tokens,
             cache_create_tokens, priced_usage_count, unpriced_usage_count, known_cost_usd,
             fired_at, acknowledged_at)
           VALUES (?, 'ws_a', ?, 'unpriced_usage', 'day', ?, ?, 1, 1, 0, 0, 0, 0, 0, 1, NULL, ?, ?)`,
        )
        .run(id, `rule_${id}`, firedAt.slice(0, 10), run, firedAt, acknowledged ? firedAt : null);
    };
    const same = "2026-10-02T00:00:00.000Z";
    for (const id of ["cal_c", "cal_a", "cal_e", "cal_b", "cal_d"]) alert(id, same);
    alert("cal_new", "2026-10-03T00:00:00.000Z");
    alert("cal_done", "2026-10-04T00:00:00.000Z", true);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const query: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const page: CostAlertPage = (
        await h.api<CostAlertPage>("GET", `/api/cost-alerts?status=open&limit=2${query}`)
      ).json;
      expect(page.total).toBe(6);
      seen.push(...page.alerts.map((a) => a.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(["cal_new", "cal_e", "cal_d", "cal_c", "cal_b", "cal_a"]);
    const all = (await h.api<CostAlertPage>("GET", "/api/cost-alerts?status=all")).json;
    expect(all).toMatchObject({ total: 7 });
    expect(all.alerts[0]?.id).toBe("cal_done");
    // A cursor of the open list is refused for another status, and a limit over 100 is refused.
    const open = (await h.api<CostAlertPage>("GET", "/api/cost-alerts?limit=2")).json;
    const foreign = encodeURIComponent(open.nextCursor ?? "");
    expect((await h.api("GET", `/api/cost-alerts?status=all&cursor=${foreign}`)).status).toBe(400);
    expect((await h.api("GET", "/api/cost-alerts?limit=101")).status).toBe(400);
    // The last cursor page past the end is empty, not an error.
    db().prepare("UPDATE cost_alerts SET acknowledged_at = fired_at").run();
    const gone = await h.api<CostAlertPage>(
      "GET",
      `/api/cost-alerts?limit=2&cursor=${encodeURIComponent(open.nextCursor ?? "")}`,
    );
    expect(gone.json).toMatchObject({ alerts: [], total: 0 });
  });

  it("pages alert rules oldest first with an honest total", async () => {
    seedWorld();
    const rule = (id: string, workspace: string) =>
      db()
        .prepare(
          `INSERT INTO cost_alert_rules (id, workspace_id, kind, window_kind, created_by, created_at)
           VALUES (?, ?, 'unpriced_usage', 'day', 'human:test', '2026-10-01T00:00:00.000Z')`,
        )
        .run(id, workspace);
    for (const id of ["car_d", "car_a", "car_c", "car_b", "car_e"]) rule(id, "ws_a");
    rule("car_f", "ws_b");
    const seen: string[] = [];
    for (const offset of [0, 2, 4]) {
      const page = (
        await h.api<CostAlertRulePage>("GET", `/api/cost-alert-rules?offset=${offset}&limit=2`)
      ).json;
      expect(page).toMatchObject({ offset, limit: 2, total: 6 });
      seen.push(...page.rules.map((r) => r.id));
    }
    expect(seen).toEqual(["car_a", "car_b", "car_c", "car_d", "car_e", "car_f"]);
    const past = (await h.api<CostAlertRulePage>("GET", "/api/cost-alert-rules?offset=8")).json;
    expect(past).toMatchObject({ rules: [], total: 6, limit: 25 });
    expect((await h.api("GET", "/api/cost-alert-rules?limit=101")).status).toBe(400);
  });
});
