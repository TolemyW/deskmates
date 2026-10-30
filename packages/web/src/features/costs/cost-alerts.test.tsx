import { selectOption } from "../../test-support/select.js";
// @vitest-environment jsdom

import type { BotDefinition, BotId, CostAlert, CostAlertRule, RunId } from "@deskmates/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import { FakeEventSource, installFakeEventSource } from "../../test-support/fixtures.js";
import { CostAlertsPanel } from "./cost-alerts.js";

afterEach(() => {
  cleanup();
  (globalThis as { EventSource?: unknown }).EventSource = undefined;
});
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
} as unknown as BotDefinition;

const rule: CostAlertRule = {
  id: "car_1",
  kind: "known_cost",
  window: "day",
  botId: bot.id as BotId,
  thresholdUsd: 2,
  createdBy: "human:web",
  createdAt: "2026-10-02T00:00:00.000Z",
};

const alert: CostAlert = {
  id: "cal_1",
  ruleId: rule.id,
  kind: "known_cost",
  window: "day",
  windowKey: "2026-10-02",
  botId: bot.id as BotId,
  thresholdUsd: 2,
  runId: "run_1" as RunId,
  totals: {
    runCount: 3,
    usageCount: 4,
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    pricedUsageCount: 3,
    unpricedUsageCount: 1,
    knownCostUsd: 2.5,
    costStatus: "partial",
  },
  firedAt: "2026-10-02T10:00:00.000Z",
};

/** `count` distinct open alerts, newest first, all for the same rule. */
function manyAlerts(count: number): CostAlert[] {
  return Array.from({ length: count }, (_, i) => ({
    ...alert,
    id: `cal_${i + 1}`,
    windowKey: `2026-09-${String(30 - i).padStart(2, "0")}`,
  }));
}

function fakeFetch(state: { alerts: CostAlert[]; rules: CostAlertRule[] }) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, ...(body === undefined ? {} : { body }) });
    if (path.startsWith("/api/cost-alerts?") && method === "GET") {
      return Response.json(alertPage(state.alerts, path));
    }
    if (path.startsWith("/api/cost-alert-rules") && method === "GET") {
      return Response.json(rulePage(state.rules, path));
    }
    if (path === "/api/cost-alert-rules" && method === "POST") {
      const created: CostAlertRule = {
        ...rule,
        id: "car_2",
        ...(body as Partial<CostAlertRule>),
      };
      state.rules = [...state.rules, created];
      return Response.json({ rule: created }, { status: 201 });
    }
    if (path.startsWith("/api/cost-alert-rules/") && method === "DELETE") {
      state.rules = state.rules.filter((r) => path.endsWith(r.id) === false);
      return Response.json({ deleted: true });
    }
    if (path.endsWith("/acknowledge") && method === "POST") {
      const id = decodeURIComponent(path.split("/")[3] ?? "");
      state.alerts = state.alerts.filter((a) => a.id !== id);
      return Response.json({
        alert: { ...alert, id, acknowledgedAt: "now", acknowledgedBy: "human:web" },
      });
    }
    return Response.json({ code: "not_found", message: path }, { status: 404 });
  });
  return { fetcher, calls };
}

/** The Gateway's alerts page: ten by default, the cursor is the next offset, the open total. */
function alertPage(alerts: CostAlert[], path: string) {
  const q = new URLSearchParams(path.split("?")[1] ?? "");
  const offset = Number(q.get("cursor") ?? 0);
  const next = offset + Number(q.get("limit") ?? 10);
  return {
    alerts: alerts.slice(offset, next),
    total: alerts.length,
    ...(next < alerts.length ? { nextCursor: String(next) } : {}),
  };
}

/** The Gateway's rules page: 25 by default, by offset, with the total. */
function rulePage(rules: CostAlertRule[], path: string) {
  const q = new URLSearchParams(path.split("?")[1] ?? "");
  const offset = Number(q.get("offset") ?? 0);
  const limit = Number(q.get("limit") ?? 25);
  return { rules: rules.slice(offset, offset + limit), offset, limit, total: rules.length };
}

function renderPanel(state: { alerts: CostAlert[]; rules: CostAlertRule[] }) {
  const fake = fakeFetch(state);
  render(<CostAlertsPanel api={createApiClient({ fetch: fake.fetcher })} bots={[bot]} />);
  return fake;
}

function alertsCard(): HTMLElement {
  return screen.getByRole("region", { name: "Cost alerts" });
}

async function openRules(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: /Manage rules/ }));
  return screen.findByRole("dialog", { name: "Alert rules" });
}

describe("Alerts card", () => {
  it("shows an alert as a scannable row with expandable details, and acknowledges it", async () => {
    const state = { alerts: [alert], rules: [rule] };
    const { calls } = renderPanel(state);

    const row = (await screen.findByRole("button", { name: "Acknowledge" })).closest("li");
    if (!row) throw new Error("alert row not rendered");
    expect(row.textContent).toContain("Known cost");
    expect(row.textContent).toContain("triage");
    expect(row.textContent).toContain("UTC day 2026-10-02");
    expect(row.textContent).toContain("$2.50 known + 1 unpriced");
    expect(screen.queryByText(/\$0\.000000/)).toBeNull();
    expect(within(alertsCard()).getByText("1 open")).toBeTruthy();

    // Secondary facts stay behind a disclosure.
    expect(within(row).queryByRole("link", { name: "Open run" })).toBeNull();
    const details = within(row).getByRole("button", { name: "Details" });
    expect(details.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(details);
    expect(details.getAttribute("aria-expanded")).toBe("true");
    expect(within(row).getByRole("link", { name: "Open run" }).getAttribute("href")).toBe(
      "#/runs/run_1",
    );
    expect(row.textContent).toContain("$2.00");
    expect(row.textContent).toContain("3 priced, 1 unpriced");

    fireEvent.click(within(row).getByRole("button", { name: "Acknowledge" }));
    await screen.findByText("No open alerts.");
    expect(calls).toContainEqual({
      method: "POST",
      path: "/api/cost-alerts/cal_1/acknowledge",
      body: {},
    });
  });

  it("shows a wholly unpriced window as unknown spend with its unpriced count, never zero", async () => {
    const { botId: _scoped, thresholdUsd: _threshold, ...unscoped } = alert;
    const unpriced: CostAlert = {
      ...unscoped,
      kind: "unpriced_usage",
      totals: {
        ...alert.totals,
        pricedUsageCount: 0,
        unpricedUsageCount: 4,
        knownCostUsd: null,
        costStatus: "unpriced",
      },
    };
    const known: CostAlert = {
      ...alert,
      id: "cal_2",
      totals: { ...alert.totals, unpricedUsageCount: 0, knownCostUsd: 3, costStatus: "priced" },
    };
    renderPanel({ alerts: [unpriced, known], rules: [rule] });
    const [first, second] = (await screen.findAllByRole("button", { name: "Acknowledge" })).map(
      (button) => button.closest("li"),
    );
    expect(first?.textContent).toContain("Unpriced usage");
    expect(first?.textContent).toContain("All Bots");
    expect(first?.textContent).toContain("Unknown spend · 4 unpriced");
    expect(second?.textContent).toContain("$3.00");
    expect(second?.textContent).not.toContain("unpriced");
    expect(screen.queryByText(/\$0\.000000/)).toBeNull();
  });

  it("separates the empty, no-rule state from loading and failure", async () => {
    let release!: (response: Response) => void;
    const state = { alerts: [] as CostAlert[], rules: [] as CostAlertRule[] };
    const { fetcher } = fakeFetch(state);
    fetcher.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    render(<CostAlertsPanel api={createApiClient({ fetch: fetcher })} bots={[bot]} />);
    expect(screen.getByText("Loading alerts…")).toBeTruthy();
    expect(screen.queryByText("No open alerts.")).toBeNull();
    await act(async () => release(Response.json({ alerts: [], total: 0 })));

    expect(await screen.findByText("No open alerts.")).toBeTruthy();
    expect(screen.getByText("No rules configured")).toBeTruthy();
    // No configuration form on the report itself.
    expect(screen.queryByLabelText("Threshold (USD)")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create rule" })).toBeNull();
    expect(screen.queryByText(/report filters do not apply/)).toBeNull();
  });

  it("shows a failed load as an error, not as an empty success", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ code: "internal", message: "Gateway is down" }, { status: 500 }),
    );
    render(<CostAlertsPanel api={createApiClient({ fetch: fetcher })} bots={[bot]} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Gateway is down");
    expect(screen.queryByText("No open alerts.")).toBeNull();
    expect(screen.queryByText("No rules configured")).toBeNull();
  });

  it("pages more than ten alerts from the Gateway and clamps the page when the last row is acknowledged (#113)", async () => {
    const state = { alerts: manyAlerts(21), rules: [rule] };
    const { calls } = renderPanel(state);
    const nav = () => screen.getByRole("navigation", { name: "Alert pagination" });
    const button = (name: string) => within(nav()).getByRole("button", { name });
    await waitFor(() => expect(nav().textContent).toContain("1–10 of 21"));
    expect(screen.getAllByRole("button", { name: "Acknowledge" })).toHaveLength(10);
    expect(button("Previous").hasAttribute("disabled")).toBe(true);
    // The badge is the Gateway's count of every open alert, not the page's length.
    expect(within(alertsCard()).getByText("21 open")).toBeTruthy();

    fireEvent.click(button("Next"));
    await waitFor(() => expect(nav().textContent).toContain("11–20 of 21"));
    fireEvent.click(button("Next"));
    await waitFor(() => expect(nav().textContent).toContain("21–21 of 21"));
    expect(button("Next").hasAttribute("disabled")).toBe(true);
    expect(calls.at(-1)?.path).toBe("/api/cost-alerts?status=open&cursor=20&limit=10");

    fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    await waitFor(() => expect(nav().textContent).toContain("11–20 of 20"));
    expect(screen.getAllByRole("button", { name: "Acknowledge" })).toHaveLength(10);
    expect(within(alertsCard()).getByText("20 open")).toBeTruthy();
  });

  it("keeps the current page valid when alerts arrive live or after a reconnect", async () => {
    installFakeEventSource();
    const state = { alerts: manyAlerts(11), rules: [rule] };
    renderPanel(state);
    const nav = () => screen.getByRole("navigation", { name: "Alert pagination" });
    await waitFor(() => expect(nav().textContent).toContain("1–10 of 11"));
    fireEvent.click(within(nav()).getByRole("button", { name: "Next" }));
    await waitFor(() => expect(nav().textContent).toContain("11–11 of 11"));

    // A live alert re-reads the page shown; it never moves the reader to another page.
    FakeEventSource.last.open();
    state.alerts = manyAlerts(12);
    FakeEventSource.last.emit({ type: "cost_alert", alert });
    await waitFor(() => expect(nav().textContent).toContain("11–12 of 12"));

    // Frames lost while the stream was down are recovered on reconnect.
    state.alerts = manyAlerts(3);
    FakeEventSource.last.readyState = 0;
    FakeEventSource.last.onerror?.(new Event("error"));
    FakeEventSource.last.open();
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Acknowledge" })).toHaveLength(3),
    );
    expect(screen.queryByRole("navigation", { name: "Alert pagination" })).toBeNull();
  });

  it("keeps an acknowledgement error on the alerts card", async () => {
    const state = { alerts: [alert], rules: [rule] };
    const { fetcher } = renderPanel(state);
    await screen.findByRole("button", { name: "Acknowledge" });
    fetcher.mockImplementationOnce(async () =>
      Response.json({ code: "conflict", message: "Already acknowledged" }, { status: 409 }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    expect((await within(alertsCard()).findByRole("alert")).textContent).toContain(
      "Already acknowledged",
    );
  });
});

describe("Alert rules panel", () => {
  it("pages more than 25 rules with the Gateway's total (#113)", async () => {
    const rules = Array.from({ length: 30 }, (_, i) => ({
      ...rule,
      id: `car_${i}`,
      thresholdUsd: i + 1,
    }));
    renderPanel({ alerts: [], rules });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Manage rules/ }).textContent).toContain("30"),
    );
    const panel = await openRules();
    const nav = within(panel).getByRole("navigation", { name: "Alert rule pages" });
    await waitFor(() => expect(nav.textContent).toContain("1–25 of 30"));
    expect(within(panel).getAllByRole("button", { name: "Delete rule" })).toHaveLength(25);
    fireEvent.click(within(nav).getByRole("button", { name: "Next" }));
    await waitFor(() => expect(nav.textContent).toContain("26–30 of 30"));
    expect(within(panel).getAllByRole("button", { name: "Delete rule" })).toHaveLength(5);
  });

  it("summarises rules by type, window, scope and threshold", async () => {
    const unpricedRule: CostAlertRule = {
      id: "car_3",
      kind: "unpriced_usage",
      window: "month",
      createdBy: rule.createdBy,
      createdAt: rule.createdAt,
    };
    renderPanel({ alerts: [], rules: [rule, unpricedRule] });
    await screen.findByText("No open alerts.");
    expect(screen.getByRole("button", { name: "Manage rules (2)" })).toBeTruthy();
    const panel = await openRules();
    expect(within(panel).getByText("2 rules")).toBeTruthy();
    expect(within(panel).getByText("Alerts notify you; they do not stop runs.")).toBeTruthy();
    const [known, unpriced] = within(panel).getAllByRole("listitem");
    expect(known?.textContent).toContain("Known cost");
    expect(known?.textContent).toContain("Day");
    expect(known?.textContent).toContain("triage");
    expect(known?.textContent).toContain("$2.00");
    expect(unpriced?.textContent).toContain("Unpriced usage");
    expect(unpriced?.textContent).toContain("Month");
    expect(unpriced?.textContent).toContain("All Bots");
    expect(unpriced?.textContent).toContain("No monetary threshold");
  });

  it("opens the form on request, creates a known-cost rule and deletes a rule", async () => {
    const state = { alerts: [], rules: [rule] };
    const { calls } = renderPanel(state);
    await screen.findByText("No open alerts.");
    const panel = await openRules();
    expect(within(panel).queryByLabelText("Threshold (USD)")).toBeNull();

    fireEvent.click(within(panel).getByRole("button", { name: "New rule" }));
    await selectOption("Window", "UTC month");
    fireEvent.change(within(panel).getByLabelText("Threshold (USD)"), {
      target: { value: "15" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Create rule" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "POST",
        path: "/api/cost-alert-rules",
        body: { kind: "known_cost", window: "month", thresholdUsd: 15 },
      }),
    );
    await within(panel).findByText("$15.00");
    // A created rule clears the draft and closes the form.
    expect(within(panel).queryByLabelText("Threshold (USD)")).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "New rule" }));
    expect((within(panel).getByLabelText("Threshold (USD)") as HTMLInputElement).value).toBe("");

    fireEvent.click(
      within(panel).getAllByRole("button", { name: "Delete rule" })[0] as HTMLElement,
    );
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "DELETE" && c.path === "/api/cost-alert-rules/car_1"),
      ).toBe(true),
    );
  });

  it("sends no threshold for an unpriced-usage rule and keeps the Gateway's refusal beside the form", async () => {
    const state = { alerts: [], rules: [] as CostAlertRule[] };
    const { fetcher, calls } = renderPanel(state);
    await screen.findByText("No rules configured");
    const panel = await openRules();
    expect(within(panel).getByText("No alert rules.")).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "New rule" }));

    await selectOption("Rule type", "Unpriced usage appears");
    expect(within(panel).queryByLabelText("Threshold (USD)")).toBeNull();
    await selectOption("Scope", bot.name);
    fireEvent.click(within(panel).getByRole("button", { name: "Create rule" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "POST",
        path: "/api/cost-alert-rules",
        body: { kind: "unpriced_usage", window: "day", botId: bot.id },
      }),
    );

    fetcher.mockImplementationOnce(async () =>
      Response.json(
        { code: "validation", message: "thresholdUsd must be a positive number", details: {} },
        { status: 400 },
      ),
    );
    fireEvent.click(within(panel).getByRole("button", { name: "New rule" }));
    fireEvent.change(within(panel).getByLabelText("Threshold (USD)"), { target: { value: "0" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Create rule" }));
    const error = await within(panel).findByRole("alert");
    expect(error.textContent).toContain("thresholdUsd must be a positive number");
    expect(error.closest("form")).not.toBeNull();
    // The form stays open with the rejected value.
    expect((within(panel).getByLabelText("Threshold (USD)") as HTMLInputElement).value).toBe("0");
    expect(within(alertsCard()).queryByRole("alert")).toBeNull();
  });

  it("keeps a rejected rule's error beside the form through a live refresh", async () => {
    installFakeEventSource();
    const state = { alerts: [] as CostAlert[], rules: [rule] };
    const { fetcher } = renderPanel(state);
    await screen.findByText("No open alerts.");
    const panel = await openRules();
    fireEvent.click(within(panel).getByRole("button", { name: "New rule" }));
    fetcher.mockImplementationOnce(async () =>
      Response.json({ code: "validation", message: "threshold too large" }, { status: 400 }),
    );
    fireEvent.change(within(panel).getByLabelText("Threshold (USD)"), { target: { value: "9" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Create rule" }));
    await within(panel).findByText("threshold too large");

    state.alerts = [alert];
    FakeEventSource.last.open();
    FakeEventSource.last.emit({ type: "cost_alert", alert });
    await screen.findByRole("button", { name: "Acknowledge" });
    expect(within(panel).getByText("threshold too large")).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "Cancel" }));
    expect(within(panel).queryByText("threshold too large")).toBeNull();
  });

  it("dismisses with Escape, returns focus and keeps the draft until cancel", async () => {
    renderPanel({ alerts: [], rules: [rule] });
    await screen.findByText("No open alerts.");
    const trigger = screen.getByRole("button", { name: /Manage rules/ });
    let panel = await openRules();
    fireEvent.click(within(panel).getByRole("button", { name: "New rule" }));
    fireEvent.change(within(panel).getByLabelText("Threshold (USD)"), {
      target: { value: "7.5" },
    });

    fireEvent.keyDown(panel, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);

    panel = await openRules();
    expect((within(panel).getByLabelText("Threshold (USD)") as HTMLInputElement).value).toBe("7.5");
    fireEvent.click(within(panel).getByRole("button", { name: "Cancel" }));
    expect(within(panel).queryByLabelText("Threshold (USD)")).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "Close alert rules" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    panel = await openRules();
    fireEvent.click(within(panel).getByRole("button", { name: "New rule" }));
    expect((within(panel).getByLabelText("Threshold (USD)") as HTMLInputElement).value).toBe("");
  });

  it("closes on an outside click and keeps receiving live alerts while closed", async () => {
    installFakeEventSource();
    const state = { alerts: [] as CostAlert[], rules: [rule] };
    renderPanel(state);
    await screen.findByText("No open alerts.");
    const panel = await openRules();
    // Pressing a button inside the panel first must not swallow the next outside press.
    fireEvent.click(within(panel).getByRole("button", { name: "New rule" }));
    fireEvent.pointerDown(within(panel).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(panel).getByRole("button", { name: "Cancel" }));
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    state.alerts = [alert];
    FakeEventSource.last.open();
    FakeEventSource.last.emit({ type: "cost_alert", alert });
    await screen.findByRole("button", { name: "Acknowledge" });
    expect(screen.queryByText("No open alerts.")).toBeNull();
  });
});

function pendingResponse() {
  let release!: (response: Response) => void;
  const promise = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("stale responses", () => {
  it("does not resurrect an acknowledged alert when an older SSE refresh returns last", async () => {
    installFakeEventSource();
    const state = { alerts: [alert], rules: [rule] };
    const { fetcher } = renderPanel(state);
    await screen.findByRole("button", { name: "Acknowledge" });
    FakeEventSource.last.open();
    const older = pendingResponse();
    fetcher.mockImplementationOnce(() => older.promise);
    FakeEventSource.last.emit({ type: "cost_alert", alert });
    await waitFor(() =>
      expect(
        fetcher.mock.calls.filter(([path]) => String(path).startsWith("/api/cost-alerts?")),
      ).toHaveLength(2),
    );

    fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    await screen.findByText("No open alerts.");
    await act(async () => older.release(Response.json({ alerts: [alert] })));
    expect(screen.queryByRole("button", { name: "Acknowledge" })).toBeNull();
    expect(screen.getByText("No open alerts.")).toBeTruthy();
  });

  it("does not restore a deleted rule from the rule list paired with an older alert request", async () => {
    installFakeEventSource();
    const state = { alerts: [], rules: [rule] };
    const { fetcher } = renderPanel(state);
    await screen.findByText("No open alerts.");
    const panel = await openRules();
    await within(panel).findByRole("button", { name: "Delete rule" });
    FakeEventSource.last.open();
    const older = pendingResponse();
    fetcher.mockImplementationOnce(() => older.promise);
    FakeEventSource.last.emit({ type: "cost_alert", alert });
    await waitFor(() =>
      expect(
        fetcher.mock.calls.filter(([path]) => String(path).startsWith("/api/cost-alerts?")),
      ).toHaveLength(2),
    );

    fireEvent.click(within(panel).getByRole("button", { name: "Delete rule" }));
    await within(panel).findByText("No alert rules.");
    await act(async () => older.release(Response.json({ alerts: [] })));
    expect(within(panel).queryByRole("button", { name: "Delete rule" })).toBeNull();
    expect(within(panel).getByText("No alert rules.")).toBeTruthy();
  });

  it("ignores a stale refresh error after a newer acknowledgement refresh succeeded", async () => {
    installFakeEventSource();
    const state = { alerts: [alert], rules: [rule] };
    const { fetcher } = renderPanel(state);
    await screen.findByRole("button", { name: "Acknowledge" });
    FakeEventSource.last.open();
    const older = pendingResponse();
    fetcher.mockImplementationOnce(() => older.promise);
    FakeEventSource.last.emit({ type: "cost_alert", alert });
    await waitFor(() =>
      expect(
        fetcher.mock.calls.filter(([path]) => String(path).startsWith("/api/cost-alerts?")),
      ).toHaveLength(2),
    );

    fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    await screen.findByText("No open alerts.");
    await act(async () =>
      older.release(
        Response.json({ code: "internal", message: "Old refresh failed" }, { status: 500 }),
      ),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("No open alerts.")).toBeTruthy();
  });
});

it("keeps the submitted rule draft locked until a failed request can be retried", async () => {
  const { fetcher } = renderPanel({ alerts: [], rules: [] });
  await screen.findByText("No rules configured");
  const panel = await openRules();
  fireEvent.click(within(panel).getByRole("button", { name: "New rule" }));
  const threshold = within(panel).getByLabelText("Threshold (USD)") as HTMLInputElement;
  fireEvent.change(threshold, { target: { value: "15" } });
  let rejectRequest: (reason: Error) => void = () => {};
  fetcher.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectRequest = reject;
      }),
  );
  const form = threshold.closest("form") as HTMLFormElement;
  const before = fetcher.mock.calls.length;
  act(() => {
    fireEvent.submit(form);
    fireEvent.submit(form);
  });
  expect(fetcher.mock.calls.length).toBe(before + 1);
  expect(threshold.disabled).toBe(true);
  expect(
    (within(panel).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  for (const control of within(panel).getAllByRole("button", { name: /Rule type|Window|Scope/ })) {
    expect(
      control.getAttribute("aria-disabled") === "true" || control.hasAttribute("disabled"),
    ).toBe(true);
  }
  await act(async () => {
    rejectRequest(new Error("Rule save unavailable"));
  });
  expect((await within(panel).findByRole("alert")).textContent).toContain(
    "Cannot connect to the server",
  );
  expect(threshold.value).toBe("15");
  expect(threshold.disabled).toBe(false);
  fireEvent.click(within(panel).getByRole("button", { name: "Create rule" }));
  await within(panel).findByText("$15.00");
});

it("retries each failed list locally without discarding an open rule draft", async () => {
  const { fetcher } = fakeFetch({ alerts: [], rules: [] });
  fetcher.mockImplementationOnce(async () =>
    Response.json({ code: "internal", message: "Alerts unavailable" }, { status: 503 }),
  );
  fetcher.mockImplementationOnce(async () =>
    Response.json({ code: "internal", message: "Rules unavailable" }, { status: 503 }),
  );
  render(<CostAlertsPanel api={createApiClient({ fetch: fetcher })} bots={[bot]} />);
  const retryAlerts = await screen.findByRole("button", { name: "Retry alerts" });
  const panel = await openRules();
  fireEvent.click(within(panel).getByRole("button", { name: "New rule" }));
  fireEvent.change(within(panel).getByLabelText("Threshold (USD)"), { target: { value: "23" } });
  fireEvent.click(within(panel).getByRole("button", { name: "Retry rules" }));
  await within(panel).findByText("No alert rules.");
  expect((within(panel).getByLabelText("Threshold (USD)") as HTMLInputElement).value).toBe("23");
  expect(screen.getByRole("button", { name: "Retry alerts" })).toBe(retryAlerts);
  fireEvent.click(retryAlerts);
  await screen.findByText("No open alerts.");
  expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
});
