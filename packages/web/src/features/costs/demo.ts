// Demo routes and seed of Costs, cost alerts and budgets: the report computed from the runs' usage, alert
// rules, and the `?costAlerts=` fixtures (empty, populated with thirteen alerts, or failing).

import {
  type BudgetLimits,
  COST_RANKING_PAGE_SIZE,
  type CostAlert,
  type CostDay,
  type CostRankingDimension,
  type CostRankingEntry,
  type CostRankingMetric,
  type CostRankingPage,
  type CostReport,
  type CostRow,
  type CostTotals,
  type RunId,
  type WorkspaceBudget,
  type WorkspaceId,
  weekEndUtc,
  weekStartUtc,
} from "@deskmates/contracts";
import type { DemoFeature, DemoRequest } from "../../demo/feature.js";
import { type Result, created, notFound, ok } from "../../demo/result.js";
import { type DemoState, id } from "../../demo/state.js";

/** A demo keyset page: the cursor is the next offset, opaque to the page like the Gateway's. */
function cursorPage<T>(items: T[], q: URLSearchParams, size: number) {
  const limit = Number(q.get("limit") ?? size) || size;
  const offset = Number(q.get("cursor") ?? 0) || 0;
  const next = offset + limit;
  return {
    items: items.slice(offset, next),
    total: items.length,
    ...(next < items.length ? { nextCursor: String(next) } : {}),
  };
}

interface CostRule {
  id: string;
  kind: string;
  window: string;
  botId?: string;
  thresholdUsd?: number;
  createdAt: string;
}

const store = (s: DemoState) =>
  s.store("costs", () => ({
    costRules: [] as CostRule[],
    costAlerts: [] as CostAlert[],
    budgets: {} as Record<string, BudgetLimits>,
  }));

/** A workspace's budget in the demo: its limits against the demo report's priced spend. */
function budgetOf(s: DemoState, workspaceId: string, workspaceName: string): WorkspaceBudget {
  const limits = store(s).budgets[workspaceId] ?? {
    weeklyLimitUsd: null,
    cumulativeLimitUsd: null,
  };
  const known = costs(s, new URLSearchParams()).totals.knownCostUsd ?? 0;
  const spend = {
    knownUsd: known,
    estimatedUsd: 0,
    totalUsd: known,
    unmeasuredUsageCount: 0,
    unestimatedUsageCount: 0,
  };
  const now = new Date();
  const exhausted =
    limits.weeklyLimitUsd !== null && known >= limits.weeklyLimitUsd
      ? "weekly"
      : limits.cumulativeLimitUsd !== null && known >= limits.cumulativeLimitUsd
        ? "cumulative"
        : null;
  return {
    workspaceId: workspaceId as WorkspaceId,
    workspaceName,
    limits,
    week: {
      startsAt: weekStartUtc(now).toISOString(),
      endsAt: weekEndUtc(now).toISOString(),
      spend,
    },
    cumulative: spend,
    exhausted,
    parks: [],
  };
}

/** The demo's rankings, grouped from its report and paged ten at a time like the Gateway's. */
function ranking(s: DemoState, q: URLSearchParams): CostRankingPage {
  const by = (q.get("by") ?? "model") as CostRankingDimension;
  const metric = (q.get("metric") ?? "money") as CostRankingMetric;
  const offset = Number(q.get("offset") ?? 0);
  const groups = new Map<string, CostRankingEntry>();
  // The demo has no operation calls (ADR-0040 amendment A), so their ranking is empty.
  const rows = by === "operation" ? [] : costs(s, q).rows;
  for (const row of rows) {
    const key = by === "bot" ? row.botId : row.model;
    const entry = groups.get(key) ?? {
      ...row,
      key,
      label: by === "bot" ? row.botName : row.model,
      runCount: 0,
      usageCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      pricedUsageCount: 0,
      knownCostUsd: 0,
    };
    entry.runCount += row.runCount;
    entry.usageCount += row.usageCount;
    entry.inputTokens += row.inputTokens;
    entry.outputTokens += row.outputTokens;
    entry.cacheReadTokens += row.cacheReadTokens;
    entry.cacheCreateTokens += row.cacheCreateTokens;
    entry.pricedUsageCount += row.pricedUsageCount;
    entry.knownCostUsd = (entry.knownCostUsd ?? 0) + (row.knownCostUsd ?? 0);
    groups.set(key, entry);
  }
  const tokensOf = (e: CostRankingEntry) =>
    e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheCreateTokens;
  const entries = [...groups.values()].sort((a, b) =>
    metric === "money" ? (b.knownCostUsd ?? 0) - (a.knownCostUsd ?? 0) : tokensOf(b) - tokensOf(a),
  );
  return {
    by,
    metric,
    filters: {},
    entries: entries.slice(offset, offset + COST_RANKING_PAGE_SIZE),
    total: entries.length,
    offset,
    limit: COST_RANKING_PAGE_SIZE,
  };
}

export const demo: DemoFeature = {
  route,
  seed: {
    after: "history",
    run: (s) => {
      if (s.costAlertFixture === "populated") seedCostAlerts(s);
    },
  },
};

function route(req: DemoRequest, s: DemoState): Result | Promise<Result> | undefined {
  const { method, path, query: q, body: b } = req;
  const m = (re: RegExp) => req.match(re);
  let x: RegExpMatchArray | null;
  if (path === "/api/costs") {
    // The summary: totals and days, never rows (#113).
    const { rows, ...report } = costs(s, q);
    return ok({ ...report, days: daysFrom(rows) });
  }
  if (path === "/api/costs/rows") {
    const page = cursorPage(costs(s, q).rows, q, 10);
    return ok({
      filters: {},
      rows: page.items,
      total: page.total,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    });
  }
  if (path === "/api/costs/ranking") return ok(ranking(s, q));
  if (path === "/api/budgets" && method === "GET")
    return ok({ budgets: s.workspaces.map((w) => budgetOf(s, w.id, w.name)) });
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/budgets\/([^/]+)$/)) && method === "PUT") {
    const workspaceId = decodeURIComponent(x?.[1] ?? "");
    const limits = {
      weeklyLimitUsd: typeof b.weeklyLimitUsd === "number" ? b.weeklyLimitUsd : null,
      cumulativeLimitUsd: typeof b.cumulativeLimitUsd === "number" ? b.cumulativeLimitUsd : null,
    };
    store(s).budgets[workspaceId] = limits;
    const name = s.workspaces.find((w) => w.id === workspaceId)?.name ?? workspaceId;
    return ok({ budget: budgetOf(s, workspaceId, name) });
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/budgets\/([^/]+)\/continue$/)) && method === "POST") {
    const workspaceId = decodeURIComponent(x?.[1] ?? "");
    const name = s.workspaces.find((w) => w.id === workspaceId)?.name ?? workspaceId;
    return ok({ continued: [], budget: budgetOf(s, workspaceId, name) });
  }
  if (s.costAlertFixture === "failure" && path.startsWith("/api/cost-alert"))
    return {
      status: 503,
      json: { code: "unavailable", message: "Cost alerts are unavailable.", details: {} },
    };
  if (path === "/api/cost-alert-rules" && method === "GET") {
    const limit = Number(q.get("limit") ?? 25) || 25;
    const offset = Number(q.get("offset") ?? 0) || 0;
    const rules = store(s).costRules;
    return ok({ rules: rules.slice(offset, offset + limit), offset, limit, total: rules.length });
  }
  if (path === "/api/cost-alert-rules" && method === "POST") {
    const rule = {
      id: id("car"),
      kind: String(b.kind),
      window: String(b.window),
      ...(b.botId ? { botId: String(b.botId) } : {}),
      ...(typeof b.thresholdUsd === "number" ? { thresholdUsd: b.thresholdUsd } : {}),
      createdAt: new Date().toISOString(),
    };
    store(s).costRules.push(rule);
    return created({ rule });
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/cost-alert-rules\/([^/]+)$/)) && method === "DELETE") {
    const i = store(s).costRules.findIndex((r) => r.id === decodeURIComponent(x?.[1] ?? ""));
    if (i >= 0) store(s).costRules.splice(i, 1);
    return ok({ deleted: true });
  }
  if (path === "/api/cost-alerts") {
    // Newest first, ten a page, with the open count (#113).
    const alerts = [...store(s).costAlerts].sort(
      (a, c) => c.firedAt.localeCompare(a.firedAt) || c.id.localeCompare(a.id),
    );
    const page = cursorPage(alerts, q, 10);
    return ok({
      alerts: page.items,
      total: page.total,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    });
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/cost-alerts\/([^/]+)\/acknowledge$/))) {
    const i = store(s).costAlerts.findIndex((a) => a.id === decodeURIComponent(x?.[1] ?? ""));
    if (i < 0) return notFound("cost alert");
    const [alert] = store(s).costAlerts.splice(i, 1);
    return ok({
      alert: { ...alert, acknowledgedAt: new Date().toISOString(), acknowledgedBy: "human:web" },
    });
  }
  if (path === "/api/prices") return ok({ prices: [] });
  return undefined;
}

function costs(s: DemoState, q: URLSearchParams): CostReport & { rows: CostRow[] } {
  const botId = q.get("botId");
  const model = q.get("model");
  const rowsByKey = new Map<string, CostRow>();
  for (const [runId, list] of s.usage) {
    const run = s.runs.get(runId);
    if (!run || (botId && run.botId !== botId)) continue;
    for (const u of list) {
      if (model && u.model !== model) continue;
      const day = (run.finishedAt ?? run.createdAt).slice(0, 10);
      const key = `${day}:${run.botId}:${u.model}`;
      const row = rowsByKey.get(key) ?? {
        day,
        botId: run.botId,
        botName: s.bots.find((b) => b.id === run.botId)?.name ?? run.botId,
        model: u.model,
        runCount: 0,
        usageCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        pricedUsageCount: 0,
        unpricedUsageCount: 0,
        knownCostUsd: 0,
        costStatus: "priced",
      };
      row.runCount += 1;
      row.usageCount += 1;
      row.inputTokens += u.inputTokens;
      row.outputTokens += u.outputTokens;
      row.cacheReadTokens += u.cacheReadTokens;
      row.pricedUsageCount += 1;
      row.knownCostUsd = (row.knownCostUsd ?? 0) + (u.costUsd ?? 0);
      rowsByKey.set(key, row);
    }
  }
  const rows = [...rowsByKey.values()].sort(
    (a, b) => b.day.localeCompare(a.day) || a.botName.localeCompare(b.botName),
  );
  const totals: CostTotals = rows.reduce(
    (acc, row) => ({
      runCount: acc.runCount + row.runCount,
      usageCount: acc.usageCount + row.usageCount,
      inputTokens: acc.inputTokens + row.inputTokens,
      outputTokens: acc.outputTokens + row.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + row.cacheReadTokens,
      cacheCreateTokens: acc.cacheCreateTokens + row.cacheCreateTokens,
      pricedUsageCount: acc.pricedUsageCount + row.pricedUsageCount,
      unpricedUsageCount: acc.unpricedUsageCount + row.unpricedUsageCount,
      knownCostUsd: (acc.knownCostUsd ?? 0) + (row.knownCostUsd ?? 0),
      costStatus: "priced",
    }),
    {
      runCount: 0,
      usageCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      pricedUsageCount: 0,
      unpricedUsageCount: 0,
      knownCostUsd: 0,
      costStatus: "priced",
    } as CostTotals,
  );
  return { filters: {}, totals, rows };
}

/** The demo's per-day totals, summed from its rows the way the Gateway groups its days. */
function daysFrom(rows: CostRow[]): CostDay[] {
  const days = new Map<string, CostDay>();
  for (const row of rows) {
    const {
      day,
      botId: _b,
      botName: _n,
      model: _m,
      workspaceId: _w,
      workspaceName: _x,
      ...t
    } = row;
    const current = days.get(day);
    days.set(
      day,
      current
        ? {
            ...current,
            runCount: current.runCount + t.runCount,
            usageCount: current.usageCount + t.usageCount,
            inputTokens: current.inputTokens + t.inputTokens,
            outputTokens: current.outputTokens + t.outputTokens,
            cacheReadTokens: current.cacheReadTokens + t.cacheReadTokens,
            cacheCreateTokens: current.cacheCreateTokens + t.cacheCreateTokens,
            pricedUsageCount: current.pricedUsageCount + t.pricedUsageCount,
            unpricedUsageCount: current.unpricedUsageCount + t.unpricedUsageCount,
            knownCostUsd: (current.knownCostUsd ?? 0) + (t.knownCostUsd ?? 0),
          }
        : { ...t, day },
    );
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** Thirteen open alerts and three rules: known, partially priced and wholly unpriced windows. */
function seedCostAlerts(s: DemoState): void {
  const second = s.bots[1];
  const runId = [...s.runs.keys()][0] ?? ("run_demo" as RunId);
  const at = "2026-10-01T00:00:00.000Z";
  store(s).costRules.push(
    { id: "car_daily", kind: "known_cost", window: "day", thresholdUsd: 2, createdAt: at },
    {
      id: "car_bot",
      kind: "known_cost",
      window: "month",
      ...(second ? { botId: second.id } : {}),
      thresholdUsd: 25,
      createdAt: at,
    },
    { id: "car_unpriced", kind: "unpriced_usage", window: "day", createdAt: at },
  );
  const totals = (known: number | null, unpriced: number): CostTotals => ({
    runCount: 4 + unpriced,
    usageCount: 9 + unpriced,
    inputTokens: 182_400,
    outputTokens: 12_900,
    cacheReadTokens: 64_000,
    cacheCreateTokens: 3_200,
    pricedUsageCount: known === null ? 0 : 9,
    unpricedUsageCount: unpriced,
    knownCostUsd: known,
    costStatus: known === null ? "unpriced" : unpriced > 0 ? "partial" : "priced",
  });
  for (let i = 0; i < 13; i += 1) {
    const day = `2026-10-${String(10 - (i % 10)).padStart(2, "0")}`;
    const kind = i % 4 === 3 ? "unpriced_usage" : "known_cost";
    const bot = i % 3 === 1 ? second : undefined;
    const rule = kind === "unpriced_usage" ? "car_unpriced" : bot ? "car_bot" : "car_daily";
    store(s).costAlerts.push({
      id: `cal_demo_${i + 1}`,
      ruleId: rule,
      kind,
      window: rule === "car_bot" ? "month" : "day",
      windowKey: rule === "car_bot" ? "2026-10" : day,
      ...(bot ? { botId: bot.id } : {}),
      ...(kind === "known_cost" ? { thresholdUsd: rule === "car_bot" ? 25 : 2 } : {}),
      runId,
      totals:
        kind === "unpriced_usage"
          ? totals(null, 2 + (i % 3))
          : totals(2.1 + i * 0.73, i % 2 === 0 ? 0 : 1),
      firedAt: `${day}T0${i % 10}:15:00.000Z`,
    } as CostAlert);
  }
}
