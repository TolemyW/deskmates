import { selectOption } from "../../test-support/select.js";
// @vitest-environment jsdom

import type { CostRankingEntry, WorkspaceBudget } from "@deskmates/contracts";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import { CostsScreen } from "./costs.js";

afterEach(cleanup);
// A page position lives in the history entry; each case starts from a clean one.
beforeEach(() => window.history.replaceState(null, ""));

const bot = {
  id: "bot_1",
  workspaceId: "ws_1",
  name: "triage",
  role: "Support",
  soulVersion: 1,
  connectors: [],
  messageAllowlist: [],
  cron: [],
  createdAt: "2026-09-23T00:00:00.000Z",
};

const totals = {
  runCount: 1,
  usageCount: 2,
  inputTokens: 1_000,
  outputTokens: 200,
  cacheReadTokens: 300,
  cacheCreateTokens: 400,
  pricedUsageCount: 1,
  unpricedUsageCount: 1,
  knownCostUsd: 2,
  costStatus: "partial",
} as const;

const entry = (key: string, extra: Partial<CostRankingEntry> = {}): CostRankingEntry => ({
  ...totals,
  key,
  label: key,
  ...extra,
});

const budget = (extra: Partial<WorkspaceBudget> = {}): WorkspaceBudget => ({
  workspaceId: "ws_1" as WorkspaceBudget["workspaceId"],
  workspaceName: "Research",
  limits: { weeklyLimitUsd: null, cumulativeLimitUsd: null },
  week: {
    startsAt: "2026-10-12T00:00:00.000Z",
    endsAt: "2026-10-19T00:00:00.000Z",
    spend: {
      knownUsd: 2,
      estimatedUsd: 0,
      totalUsd: 2,
      unmeasuredUsageCount: 0,
      unestimatedUsageCount: 0,
    },
  },
  cumulative: {
    knownUsd: 2,
    estimatedUsd: 0,
    totalUsd: 2,
    unmeasuredUsageCount: 0,
    unestimatedUsageCount: 0,
  },
  exhausted: null,
  parks: [],
  ...extra,
});

interface World {
  report?: unknown;
  /** The Activity rows the Gateway pages; by default the report's own rows. */
  rows?: () => unknown[];
  ranking?: (path: string) => unknown;
  budgets?: WorkspaceBudget[];
  onRequest?: (path: string, init?: RequestInit) => Response | undefined;
}

/** A fake Gateway for the page: report, rankings, budgets, alerts. Records every path. */
function gateway(world: World) {
  const paths: string[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    paths.push(path);
    const custom = world.onRequest?.(path, init);
    if (custom) return custom;
    if (path === "/api/bots") return Response.json({ bots: [bot] });
    if (path.startsWith("/api/cost-alert-rules"))
      return Response.json({ rules: [], offset: 0, limit: 25, total: 0 });
    if (path.startsWith("/api/cost-alerts?")) return Response.json({ alerts: [], total: 0 });
    if (path.startsWith("/api/costs/rows")) {
      // Activity rows, a keyset page at a time; the demo cursor is the next offset.
      const q = new URLSearchParams(path.split("?")[1] ?? "");
      const all =
        world.rows?.() ?? ((world.report ?? defaultReport) as { rows?: unknown[] }).rows ?? [];
      const offset = Number(q.get("cursor") ?? 0);
      const next = offset + Number(q.get("limit") ?? 10);
      return Response.json({
        filters: {},
        rows: all.slice(offset, next),
        total: all.length,
        ...(next < all.length ? { nextCursor: String(next) } : {}),
      });
    }
    if (path === "/api/budgets") return Response.json({ budgets: world.budgets ?? [] });
    if (path.startsWith("/api/costs/ranking"))
      return Response.json(
        world.ranking?.(path) ?? { entries: [], total: 0, offset: 0, limit: 10 },
      );
    return Response.json(world.report ?? defaultReport);
  });
  return { api: createApiClient({ fetch: fetcher }), paths };
}

const defaultReport = {
  filters: {},
  totals,
  rows: [{ day: "2026-09-23", botId: bot.id, botName: bot.name, model: "model-a", ...totals }],
};

const reportPaths = (paths: string[]) =>
  paths.filter((p) => p === "/api/costs" || p.startsWith("/api/costs?"));

it("shows every token type and labels partial cost as known plus unpriced", async () => {
  const { api } = gateway({
    report: {
      filters: {},
      totals: { ...totals, attributionUncertain: true },
      rows: [{ day: "2026-09-23", botId: bot.id, botName: bot.name, model: "model-a", ...totals }],
    },
  });
  render(<CostsScreen api={api} />);

  const table = await screen.findByRole("table");
  expect(screen.getByText("Includes session usage with uncertain run attribution.")).toBeTruthy();
  // The rows arrive from their own page request, after the summary.
  await waitFor(() => expect(table.textContent).toContain("1,000"));
  expect(table.textContent).toContain("200");
  expect(table.textContent).toContain("300");
  expect(table.textContent).toContain("400");
  expect(screen.getAllByText("$2.000000 known + 1 unpriced").length).toBeGreaterThanOrEqual(2);
});

it("places the alerts card after the totals and before the charts and Activity", async () => {
  const { api } = gateway({});
  render(<CostsScreen api={api} />);
  await screen.findByRole("table");
  const totalsRegion = screen.getByRole("region", { name: "Cost totals" });
  const alerts = screen.getByRole("region", { name: "Cost alerts" });
  const activity = screen.getByRole("heading", { name: "Activity" });
  const chart = screen.getAllByRole("img")[0] as Element;
  const follows = (a: Node, b: Node) =>
    Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  expect(follows(totalsRegion, alerts)).toBe(true);
  expect(follows(alerts, chart)).toBe(true);
  expect(follows(alerts, activity)).toBe(true);
  // The report's filters never reach the alerts card; it stays mounted while the report reloads.
  fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
  expect(screen.getByRole("region", { name: "Cost alerts" })).toBe(alerts);
});

it("applies inclusive date, bot and exact-model filters to the report and the rankings", async () => {
  const { api, paths } = gateway({
    report: { filters: {}, totals: { ...totals, usageCount: 0 }, rows: [] },
  });
  render(<CostsScreen api={api} />);
  await screen.findByText("No usage matches these filters.");

  fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-09-01" } });
  fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-09-23" } });
  await selectOption("Bot", bot.name);
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "model/custom" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));

  await waitFor(() =>
    expect(paths).toContain(
      "/api/costs?from=2026-09-01&to=2026-09-23&botId=bot_1&model=model%2Fcustom",
    ),
  );
});

it("renders loading, empty, error and wholly unpriced states without showing unknown as zero", async () => {
  let resolve!: (response: Response) => void;
  const pending = new Promise<Response>((done) => {
    resolve = done;
  });
  const { api } = gateway({
    onRequest: (path) => {
      if (!reportPaths([path]).length) return undefined;
      // The first report request stays pending; later ones answer the from-after-to filter with
      // the Gateway's validation error.
      if (!path.includes("from=2026-09-23")) return pending as unknown as Response;
      return Response.json(
        { code: "validation", message: "from must be on or before to", details: {} },
        { status: 400 },
      );
    },
  });
  render(<CostsScreen api={api} />);
  expect(screen.getByText("Loading costs…")).toBeTruthy();

  resolve(
    Response.json({
      filters: {},
      totals: {
        ...totals,
        knownCostUsd: null,
        pricedUsageCount: 0,
        unpricedUsageCount: 2,
        costStatus: "unpriced",
      },
      rows: [],
    }),
  );
  await screen.findByText("No usage matches these filters.");
  expect(screen.getByText("Unpriced (2 usage rows)")).toBeTruthy();
  expect(screen.queryByText("$0.000000")).toBeNull();

  fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-09-23" } });
  fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-09-01" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
  expect((await screen.findByRole("alert")).textContent).toContain("from must be on or before to");
});

it("pages Activity from the Gateway without changing totals and resets after applying filters (#113)", async () => {
  let filtered = false;
  const rows = Array.from({ length: 23 }, (_, i) => ({
    ...totals,
    day: `2026-09-${String(30 - i).padStart(2, "0")}`,
    botId: bot.id,
    botName: bot.name,
    model: "model-a",
  }));
  // The summary never carries rows; the Activity table reads them a page at a time.
  const { api, paths } = gateway({
    report: { filters: {}, totals, days: [{ day: "2026-09-30", ...totals }] },
    rows: () => (filtered ? rows.slice(0, 2) : rows),
  });
  render(<CostsScreen api={api} />);
  const table = await screen.findByRole("table");
  const nav = () => screen.getByRole("navigation", { name: "Activity pagination" });
  await waitFor(() => expect(nav()).toHaveTextContent("1–10 of 23"));
  const totalsBefore = screen.getByRole("region", { name: "Cost totals" }).textContent;
  expect(within(table).getAllByRole("row")).toHaveLength(11);
  expect(within(nav()).getByRole("button", { name: "Previous" })).toBeDisabled();
  fireEvent.click(within(nav()).getByRole("button", { name: "Next" }));
  await waitFor(() => expect(nav()).toHaveTextContent("11–20 of 23"));
  expect(table.textContent).not.toContain("2026-09-30");
  fireEvent.click(within(nav()).getByRole("button", { name: "Next" }));
  await waitFor(() => expect(nav()).toHaveTextContent("21–23 of 23"));
  expect(within(table).getAllByRole("row")).toHaveLength(4);
  expect(within(nav()).getByRole("button", { name: "Next" })).toBeDisabled();
  expect(paths.filter((p) => p.startsWith("/api/costs/rows")).at(-1)).toContain("cursor=20");
  // Paging never reloads or changes the summary.
  expect(screen.getByRole("region", { name: "Cost totals" }).textContent).toBe(totalsBefore);
  expect(reportPaths(paths)).toHaveLength(1);
  // Back and Forward step between pages.
  act(() => window.history.back());
  await waitFor(() => expect(nav()).toHaveTextContent("11–20 of 23"));
  act(() => window.history.forward());
  await waitFor(() => expect(nav()).toHaveTextContent("21–23 of 23"));
  fireEvent.click(within(nav()).getByRole("button", { name: "Previous" }));
  await waitFor(() => expect(nav()).toHaveTextContent("11–20 of 23"));
  filtered = true;
  fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
  await waitFor(() => expect(nav()).toHaveTextContent("1–2 of 2"));
  expect(within(nav()).getByRole("button", { name: "Next" })).toBeDisabled();
});

it("opens on money, and the toggle switches tiles, chart and rankings together (ADR-0032)", async () => {
  const estimated = {
    ...totals,
    knownCostUsd: 2,
    estimatedCostUsd: 0.5,
    estimatedUsageCount: 1,
    unestimatedUsageCount: 0,
  };
  const { api, paths } = gateway({
    report: {
      filters: {},
      totals: estimated,
      rows: [
        { day: "2026-09-23", botId: bot.id, botName: bot.name, model: "model-a", ...estimated },
      ],
      days: [{ day: "2026-09-23", ...estimated }],
      estimate: { version: "avg-unit-price-v1" },
    },
    ranking: (path) => ({
      entries: path.includes("by=bot")
        ? [
            entry("bot_a", { label: "Scout", workspaceName: "Research", ...estimated }),
            entry("bot_b", {
              label: "Scout",
              workspaceName: "Support",
              knownCostUsd: null,
              estimatedCostUsd: null,
            }),
          ]
        : [entry("model-a", estimated)],
      total: path.includes("by=bot") ? 2 : 1,
      offset: 0,
      limit: 10,
    }),
  });
  const { unmount } = render(<CostsScreen api={api} />);
  await screen.findByRole("table");
  const money = screen.getByRole("button", { name: "Money" });
  expect(money.getAttribute("aria-pressed")).toBe("true");
  const tiles = screen.getByRole("region", { name: "Cost totals" });
  expect(tiles.textContent).toContain("Total cost (includes estimates)");
  expect(tiles.textContent).toContain("$2.50");
  expect(tiles.textContent).toContain("Estimated cost");
  expect(screen.getByText(/avg-unit-price-v1/)).toBeTruthy();
  const byBot = await screen.findByRole("region", { name: "By bot" });
  await waitFor(() => expect(byBot.textContent).toContain("Scout · Research"));
  expect(byBot.textContent).toContain("Scout · Support");
  // Money rankings show money only: the unpriced entry says so, and no token counts appear.
  expect(byBot.textContent).toContain("Unpriced");
  expect(byBot.textContent).toContain("$2.50 incl. estimate");
  expect(byBot.textContent).not.toMatch(/tok/);
  expect(paths.some((p) => p.includes("metric=money"))).toBe(true);

  fireEvent.click(screen.getByRole("button", { name: "Usage" }));
  expect(screen.getByRole("button", { name: "Usage" }).getAttribute("aria-pressed")).toBe("true");
  const usageTiles = screen.getByRole("region", { name: "Cost totals" });
  expect(usageTiles.textContent).not.toContain("$");
  expect(usageTiles.textContent).toContain("Cache create");
  expect(screen.getByRole("heading", { name: "Tokens per day" })).toBeTruthy();
  await waitFor(() => expect(paths.some((p) => p.includes("metric=usage"))).toBe(true));
  await waitFor(() =>
    expect(screen.getByRole("region", { name: "By bot" }).textContent).not.toContain("$"),
  );

  // The choice is not remembered: a new visit opens on money again.
  unmount();
  render(<CostsScreen api={api} />);
  await screen.findByRole("table");
  expect(screen.getByRole("button", { name: "Money" }).getAttribute("aria-pressed")).toBe("true");
});

it("pages a ranking ten at a time from the Gateway without changing the totals", async () => {
  const { api, paths } = gateway({
    ranking: (path) => {
      const offset = Number(new URL(path, "http://x").searchParams.get("offset") ?? 0);
      const all = Array.from({ length: 13 }, (_, i) => entry(`model-${i}`));
      return { entries: all.slice(offset, offset + 10), total: 13, offset, limit: 10 };
    },
  });
  render(<CostsScreen api={api} />);
  await screen.findByRole("table");
  const totalsBefore = screen.getByRole("region", { name: "Cost totals" }).textContent;
  const byModel = screen.getByRole("region", { name: "By model" });
  await waitFor(() => expect(within(byModel).getAllByRole("listitem")).toHaveLength(10));
  fireEvent.click(screen.getByRole("button", { name: "Next page of By model" }));
  await waitFor(() => expect(within(byModel).getAllByRole("listitem")).toHaveLength(3));
  expect(paths.some((p) => p.startsWith("/api/costs/ranking") && p.includes("offset=10"))).toBe(
    true,
  );
  expect(screen.getByRole("region", { name: "Cost totals" }).textContent).toBe(totalsBefore);
  expect(reportPaths(paths)).toHaveLength(1);
});

it("edits a workspace budget and continues parked work only when the limit allows (ADR-0032)", async () => {
  const parked = budget({
    limits: { weeklyLimitUsd: 2, cumulativeLimitUsd: null },
    exhausted: "weekly",
    parks: [
      {
        id: "bp_1",
        workspaceId: "ws_1" as WorkspaceBudget["workspaceId"],
        runId: "run_9" as WorkspaceBudget["parks"][number]["runId"],
        botId: "bot_1" as WorkspaceBudget["parks"][number]["botId"],
        botName: "triage",
        runStatus: "queued",
        attempt: 1,
        checkpoint: "admission",
        limitKind: "weekly",
        spendUsd: 2,
        limitUsd: 2,
        parkedAt: "2026-10-13T00:00:00.000Z",
      },
    ],
  });
  const puts: unknown[] = [];
  const { api, paths } = gateway({
    budgets: [parked],
    onRequest: (path, init) => {
      if (path === "/api/budgets/ws_1" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        puts.push(body);
        return Response.json({ budget: { ...parked, limits: body, exhausted: null } });
      }
      if (path === "/api/budgets/ws_1/continue")
        return Response.json({ continued: ["run_9"], budget: budget() });
      return undefined;
    },
  });
  render(<CostsScreen api={api} />);
  const panel = await screen.findByRole("region", { name: "Workspace budgets" });
  await waitFor(() => expect(panel.textContent).toContain("Weekly limit reached"));
  expect(panel.textContent).toContain("Budget insufficient, waiting to continue:");
  const resume = within(panel).getByRole("button", { name: "Continue parked work" });
  expect(resume.hasAttribute("disabled")).toBe(true);

  fireEvent.click(within(panel).getByRole("button", { name: "Edit limits" }));
  fireEvent.change(within(panel).getByLabelText("Weekly limit (USD)"), {
    target: { value: "0" },
  });
  fireEvent.click(within(panel).getByRole("button", { name: "Save limits" }));
  expect(within(panel).getByRole("alert").textContent).toContain("positive amount");
  fireEvent.change(within(panel).getByLabelText("Weekly limit (USD)"), {
    target: { value: "10" },
  });
  fireEvent.click(within(panel).getByRole("button", { name: "Save limits" }));
  await waitFor(() => expect(puts).toEqual([{ weeklyLimitUsd: 10, cumulativeLimitUsd: null }]));
  // Raising the limit resumes nothing by itself; Continue is now offered.
  expect(paths).not.toContain("/api/budgets/ws_1/continue");
  const enabled = await within(panel).findByRole("button", { name: "Continue parked work" });
  await waitFor(() => expect(enabled.hasAttribute("disabled")).toBe(false));
  fireEvent.click(enabled);
  await waitFor(() => expect(paths).toContain("/api/budgets/ws_1/continue"));
  await waitFor(() => expect(panel.textContent).not.toContain("Budget insufficient"));
});
