// @vitest-environment jsdom
// The workspace detail's Web search section (ADR-0049 decision 4): on by default and saying so;
// the information flow (queries leave the installation, also from a locked workspace; opening a
// result still follows egress) in every locale; turning on only where search is configured;
// on, off and back to the default sent as exactly that.

import type { WebSearchView, WorkspaceDirectoryEntry } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import en from "./messages/en.json";
import es from "./messages/es.json";
import ja from "./messages/ja.json";
import zhCN from "./messages/zh-CN.json";
import zhTW from "./messages/zh-TW.json";
import { WebSearchSection } from "./web-search-section.js";

afterEach(cleanup);

const entry = { id: "ws_1", name: "Desk" } as WorkspaceDirectoryEntry;

function view(extra: Partial<WebSearchView> = {}): WebSearchView {
  return {
    workspaceId: "ws_1",
    configured: true,
    enabled: null,
    effective: true,
    defaultEnabled: true,
    updatedBy: null,
    updatedAt: null,
    ...extra,
  };
}

function client(initial: WebSearchView, after?: WebSearchView) {
  const puts: unknown[] = [];
  const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PUT") {
      puts.push(JSON.parse(String(init.body)));
      return Response.json({ webSearch: after ?? initial });
    }
    return Response.json({ webSearch: initial });
  });
  return { api: createApiClient({ fetch: fetcher }), puts };
}

it("shows on by default and can disable inherited search without an explicit stored choice", async () => {
  const { api, puts } = client(view(), view({ enabled: false, effective: false }));
  render(<WebSearchSection api={api} entry={entry} onChanged={() => {}} />);
  expect(await screen.findByText(en["webSearch.setting.default"])).toBeTruthy();
  expect(screen.getByText(en["webSearch.setting.default"]).closest("dd")?.textContent).toMatch(
    new RegExp(`^${en["webSearch.on"]}`),
  );
  expect(screen.getByText(en["webSearch.flow"])).toBeTruthy();
  fireEvent.click(screen.getByText(en["webSearch.disable"]));
  await waitFor(() => expect(puts).toEqual([{ enabled: false }]));
  expect(await screen.findByText(en["webSearch.enable"])).toBeTruthy();
});

it("turns it off and returns to the default", async () => {
  const on = view({ enabled: true, effective: true });
  const { api, puts } = client(on);
  render(<WebSearchSection api={api} entry={entry} onChanged={() => {}} />);
  fireEvent.click(await screen.findByText(en["webSearch.disable"]));
  await waitFor(() => expect(puts).toEqual([{ enabled: false }]));
  fireEvent.click(screen.getByText(en["webSearch.reset"]));
  await waitFor(() => expect(puts).toEqual([{ enabled: false }, { enabled: null }]));
});

it("offers no enable button where the installation has no search service", async () => {
  const { api } = client(view({ configured: false, effective: false }));
  render(<WebSearchSection api={api} entry={entry} onChanged={() => {}} />);
  expect(await screen.findByText(en["webSearch.notConfigured"])).toBeTruthy();
  expect(screen.queryByText(en["webSearch.enable"])).toBeNull();
});

it("states the on default and the information flow in every locale", () => {
  for (const messages of [en, es, ja, zhCN, zhTW]) {
    expect(Object.keys(messages).sort()).toEqual(Object.keys(en).sort());
    expect(messages["webSearch.flow"].length).toBeGreaterThan(40);
  }
  expect(en["webSearch.intro"]).toContain("on by default");
  expect(en["webSearch.flow"]).toContain("locked");
  expect(en["webSearch.flow"]).toContain("egress rules");
  for (const messages of [es, ja, zhCN, zhTW])
    expect(messages["webSearch.flow"]).not.toBe(en["webSearch.flow"]);
});

it("recovers a failed settings read without changing the search policy", async () => {
  const { api, puts } = client(view());
  const get = vi
    .spyOn(api, "getWorkspaceWebSearch")
    .mockRejectedValueOnce(new Error("Read failed"));
  render(<WebSearchSection api={api} entry={entry} onChanged={() => {}} />);
  expect((await screen.findByRole("alert")).textContent).toContain("Read failed");
  expect(screen.queryByText(en["webSearch.disable"])).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: en["webSearch.retry"] }));
  expect(await screen.findByText(en["webSearch.setting.default"])).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(get).toHaveBeenCalledTimes(2);
  expect(puts).toEqual([]);
});
