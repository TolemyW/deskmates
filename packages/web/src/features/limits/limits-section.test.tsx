// @vitest-environment jsdom
// The workspace Limits section (ADR-0005 amendment 5 decisions 39 to 42, ADR-0016 amendment 2):
// shows each counter's effective value with its source, the switches and the loop breaker; saves
// numbers, `off` without a budget, and the switches through the API.

import type { WorkspaceLimitsView } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import { LimitsSection } from "./limits-section.js";

afterEach(cleanup);

const ranges = {
  continuationLimit: { min: 0, max: 20, off: true },
  continuationWindowHours: { min: 1, max: 168, off: false },
  maxTurns: { min: 1, max: 1000, off: true },
  relayCountMax: { min: 1, max: 50, off: true },
  turnBudget: { min: 1, max: 300, off: true },
  turnBudgetResetMinutes: { min: 5, max: 1440, off: false },
};
const defaults = {
  continuationLimit: 2,
  continuationWindowHours: 24,
  maxTurns: 80,
  relayCountMax: 5,
  turnBudget: null,
  turnBudgetResetMinutes: 60,
};

function view(extra: Partial<WorkspaceLimitsView> = {}): WorkspaceLimitsView {
  return {
    workspaceId: "ws_1",
    settings: {},
    effective: {
      continuationLimit: { value: 2, source: "default" },
      continuationWindowHours: { value: 24, source: "default" },
      maxTurns: { value: 80, source: "gateway" },
      relayCountMax: { value: 5, source: "default" },
      turnBudget: { value: null, source: "default" },
      turnBudgetResetMinutes: { value: 60, source: "default" },
    },
    switches: { requireBudgetForOff: false, volumeBreaker: false },
    defaults,
    ranges,
    loopBreaker: { relayMax: 50, botMessages: 300, repeats: 3 },
    budgetBackstop: false,
    ...extra,
  };
}

function client(initial: WorkspaceLimitsView) {
  const puts: unknown[] = [];
  const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as Record<string, number | null>;
      puts.push(body);
      const next = view({
        settings: { turnBudget: 20 },
        effective: { ...initial.effective, turnBudget: { value: 20, source: "workspace" } },
      });
      return new Response(JSON.stringify({ limits: next }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ limits: initial }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { api: createApiClient({ fetch: fetcher }), puts, fetcher };
}

it("shows every counter with its effective value and source, and the loop breaker", async () => {
  const { api } = client(view());
  render(<LimitsSection api={api} workspaceId="ws_1" />);
  expect(await screen.findByText("80 · server default")).toBeTruthy();
  expect(
    screen.getByText("Turn budget (Bot messages per chat since the last human message)"),
  ).toBeTruthy();
  expect(screen.getByText("Off · default")).toBeTruthy();
  expect(screen.getByText(/chain deeper than 50 hops wakes nobody/)).toBeTruthy();
  expect(
    screen.getByText("Pause a chat after 300 Bot messages since the last human message"),
  ).toBeTruthy();
  expect(screen.getByText("Require a budget for unlimited limits")).toBeTruthy();
});

it("saves a turn budget, sends the other keys as inherit, and offers off without a budget", async () => {
  const { api, puts } = client(view());
  render(<LimitsSection api={api} workspaceId="ws_1" />);
  fireEvent.click(await screen.findByText("Edit limits"));
  const offBoxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
  expect(offBoxes.every((box) => !box.disabled)).toBe(true);
  expect(screen.queryByText(/requires a weekly or cumulative budget/)).toBeNull();
  const budget = screen.getByLabelText(
    "Turn budget (Bot messages per chat since the last human message)",
  ) as HTMLInputElement;
  expect(budget.placeholder).toBe("Default Off");
  fireEvent.change(budget, { target: { value: "20" } });
  fireEvent.click(
    screen.getByLabelText("Pause a chat after 300 Bot messages since the last human message"),
  );
  fireEvent.click(screen.getByText("Save limits"));
  await waitFor(() => expect(puts).toHaveLength(1));
  expect(puts[0]).toEqual({
    continuationLimit: null,
    continuationWindowHours: null,
    maxTurns: null,
    relayCountMax: null,
    turnBudget: 20,
    turnBudgetResetMinutes: null,
    volumeBreaker: true,
  });
  expect(await screen.findByText("20 · workspace setting")).toBeTruthy();
});

it("offers off only with a budget while the workspace requires one", async () => {
  const { api } = client(view({ switches: { requireBudgetForOff: true, volumeBreaker: false } }));
  render(<LimitsSection api={api} workspaceId="ws_1" />);
  fireEvent.click(await screen.findByText("Edit limits"));
  const offBoxes = (screen.getAllByRole("checkbox") as HTMLInputElement[]).filter(
    (box) => box.parentElement?.textContent === "Off",
  );
  expect(offBoxes).toHaveLength(4);
  expect(offBoxes.every((box) => box.disabled)).toBe(true);
  expect(screen.getByText(/requires a weekly or cumulative budget/)).toBeTruthy();
});

it("refuses a value out of range without calling the API", async () => {
  const { api, puts } = client(view({ budgetBackstop: true }));
  render(<LimitsSection api={api} workspaceId="ws_1" />);
  fireEvent.click(await screen.findByText("Edit limits"));
  fireEvent.change(screen.getByLabelText("Relay cap (hops in one message chain)"), {
    target: { value: "51" },
  });
  fireEvent.click(screen.getByText("Save limits"));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("from 1 to 50");
  expect(puts).toHaveLength(0);
});

it("shows and saves the turn-budget reset window, never off (ADR-0005 amendment 3, decision 22)", async () => {
  const { api, puts } = client(view());
  render(<LimitsSection api={api} workspaceId="ws_1" />);
  expect(
    await screen.findByText("Minutes until a chat paused by its turn budget resumes by itself"),
  ).toBeTruthy();
  expect(screen.getByText("60 · default")).toBeTruthy();
  fireEvent.click(screen.getByText("Edit limits"));
  const field = screen.getByLabelText(
    "Minutes until a chat paused by its turn budget resumes by itself",
  ) as HTMLInputElement;
  expect(field.closest(".limits-field")?.querySelector("input[type=checkbox]")).toBeNull();
  fireEvent.change(field, { target: { value: "15" } });
  fireEvent.click(screen.getByText("Save limits"));
  await waitFor(() => expect(puts).toHaveLength(1));
  expect(puts[0]).toMatchObject({ turnBudgetResetMinutes: 15 });
});

it("neither shows nor sends a key an older Gateway does not report", async () => {
  const older = view();
  const { turnBudgetResetMinutes: _range, ...olderRanges } = older.ranges;
  const { turnBudgetResetMinutes: _effective, ...olderEffective } = older.effective;
  const { api, puts } = client({
    ...older,
    ranges: olderRanges as typeof older.ranges,
    effective: olderEffective as typeof older.effective,
  });
  render(<LimitsSection api={api} workspaceId="ws_1" />);
  fireEvent.click(await screen.findByText("Edit limits"));
  expect(screen.queryByText(/resumes by itself/)).toBeNull();
  fireEvent.click(screen.getByText("Save limits"));
  await waitFor(() => expect(puts).toHaveLength(1));
  expect(puts[0]).not.toHaveProperty("turnBudgetResetMinutes");
});
