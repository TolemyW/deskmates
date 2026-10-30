// @vitest-environment jsdom
// The bot editor's Run statistics section (ADR-0050 decision 6): off by default and saying so,
// with the strategy and freeze notes, in every locale; an Owner or Admin turns it on and off with
// one PUT each; opening it only reads.

import type { BotId, BotRunStatsSetting, WorkspaceId } from "@deskmates/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import en from "./messages/en.json";
import es from "./messages/es.json";
import ja from "./messages/ja.json";
import zhCN from "./messages/zh-CN.json";
import zhTW from "./messages/zh-TW.json";
import { RunStatsSection } from "./run-stats-section.js";

afterEach(cleanup);

const bot = { id: "bot_nova" as BotId, name: "nova", workspaceId: "ws_1" as WorkspaceId };

function client(initial: boolean) {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  let enabled = initial;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url: String(input), ...(body ? { body } : {}) });
    if (method === "PUT") enabled = (body as { enabled: boolean }).enabled;
    const runStats: BotRunStatsSetting = { botId: bot.id, enabled };
    return Response.json({ runStats });
  });
  return { api: createApiClient({ fetch: fetcher }), calls };
}

it("says the tool is off by default, with the strategy and freeze notes, and only reads", async () => {
  const { api, calls } = client(false);
  render(<RunStatsSection api={api} bot={bot} />);
  expect(await screen.findByText(en["runStats.off"])).toBeTruthy();
  expect(screen.getByText(en["runStats.strategyNote"])).toBeTruthy();
  expect(screen.getByText(en["runStats.frozen"])).toBeTruthy();
  expect(screen.getByText(/Only this Bot's own figures/)).toBeTruthy();
  expect(calls.map((c) => c.method)).toEqual(["GET"]);
  expect(calls[0]?.url).toContain("/api/bots/bot_nova/run-stats");
});

it("turns the tool on and off with one PUT each", async () => {
  const { api, calls } = client(false);
  render(<RunStatsSection api={api} bot={bot} />);
  fireEvent.click(await screen.findByText(en["runStats.enable"]));
  expect(await screen.findByText(en["runStats.on"])).toBeTruthy();
  fireEvent.click(screen.getByText(en["runStats.disable"]));
  await waitFor(() => expect(screen.getByText(en["runStats.off"])).toBeTruthy());
  expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([
    { enabled: true },
    { enabled: false },
  ]);
});

it("has every key in every locale, translated", () => {
  for (const catalog of [es, ja, zhCN, zhTW] as Record<string, string>[]) {
    expect(Object.keys(catalog).sort()).toEqual(Object.keys(en).sort());
    expect(catalog["runStats.intro"]).not.toBe(en["runStats.intro"]);
    expect(catalog["runStats.intro"]).toContain("{name}");
    expect(catalog["runStats.intro"]).toContain("run_stats");
  }
});

it("retries a failed read without enabling the statistics tool", async () => {
  const getBotRunStats = vi
    .fn()
    .mockRejectedValueOnce(new Error("Unavailable"))
    .mockResolvedValue({ botId: bot.id, enabled: false });
  const setBotRunStats = vi.fn();
  render(<RunStatsSection api={{ getBotRunStats, setBotRunStats }} bot={bot} />);
  expect((await screen.findByRole("alert")).textContent).toContain("Unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText(en["runStats.off"]);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(setBotRunStats).not.toHaveBeenCalled();
});

it("does not apply a previous bot's late save to the selected bot", async () => {
  let finish!: (value: BotRunStatsSetting) => void;
  const api = {
    getBotRunStats: vi.fn(async (id: BotId) => ({ botId: id, enabled: false })),
    setBotRunStats: vi.fn(
      () =>
        new Promise<BotRunStatsSetting>((resolve) => {
          finish = resolve;
        }),
    ),
  };
  const view = render(<RunStatsSection api={api} bot={bot} />);
  fireEvent.click(await screen.findByText(en["runStats.enable"]));
  const second = { ...bot, id: "bot_second" as BotId, name: "second" };
  view.rerender(<RunStatsSection api={api} bot={second} />);
  await screen.findByText(en["runStats.off"]);
  await act(async () => {
    finish({ botId: bot.id, enabled: true });
  });
  expect(screen.queryByText(en["runStats.on"])).toBeNull();
  expect(screen.getByText(en["runStats.off"])).toBeTruthy();
  expect(api.setBotRunStats).toHaveBeenCalledTimes(1);
});
