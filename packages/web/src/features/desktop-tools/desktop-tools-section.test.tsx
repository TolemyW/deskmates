// @vitest-environment jsdom
// The workspace detail's Desktop tools section (ADR-0048 decisions 1 and 10, amendment 1 A1): on by
// default on a capable image, saying so, with the grouping-exception warning whenever the tools
// are on, in every locale; off with no warning otherwise; turning on only offered on a capable
// image; bots saved as the changes only.

import type { DesktopToolsView, WorkspaceDirectoryEntry } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import { DesktopToolsSection } from "./desktop-tools-section.js";
import en from "./messages/en.json";
import es from "./messages/es.json";
import ja from "./messages/ja.json";
import zhCN from "./messages/zh-CN.json";
import zhTW from "./messages/zh-TW.json";

afterEach(cleanup);

const entry = { id: "ws_1", name: "Desk" } as WorkspaceDirectoryEntry;

function view(extra: Partial<DesktopToolsView> = {}): DesktopToolsView {
  return {
    workspaceId: "ws_1",
    enabled: false,
    setting: "off",
    image: "capable",
    bots: [
      { botId: "bot_nova", name: "nova", enabled: false, setting: "default" },
      { botId: "bot_vega", name: "vega", enabled: false, setting: "off" },
    ],
    groupingException: false,
    ...extra,
  };
}

function client(initial: DesktopToolsView, after?: DesktopToolsView) {
  const puts: unknown[] = [];
  const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PUT") {
      puts.push(JSON.parse(String(init.body)));
      return Response.json({ desktopTools: after ?? initial });
    }
    return Response.json({ desktopTools: initial });
  });
  return { api: createApiClient({ fetch: fetcher }), puts };
}

it("shows no grouping warning while the tools are off", async () => {
  const { api } = client(view());
  render(<DesktopToolsSection api={api} entry={entry} onChanged={() => {}} />);
  expect(await screen.findByText(en["desktopTools.image.capable"])).toBeTruthy();
  expect(screen.queryByText(/Grouping exception/)).toBeNull();
});

it("shows the grouping warning and the no-approval note while the tools are on", async () => {
  const { api } = client(
    view({
      enabled: true,
      mode: "lcu-v1",
      lcuVersion: "0.11.3",
      appVersion: "26.915.31945",
      groupingException: true,
      bots: [{ botId: "bot_nova", name: "nova", enabled: true, setting: "default" }],
    }),
  );
  render(<DesktopToolsSection api={api} entry={entry} onChanged={() => {}} />);
  expect(await screen.findByText(en["desktopTools.groupingWarning"])).toBeTruthy();
  expect(screen.getByText(en["desktopTools.noApproval"])).toBeTruthy();
  expect(screen.getByText("LCU 0.11.3 · application 26.915.31945")).toBeTruthy();
});

it("says the tools are on by default on a capable image, or that the state was chosen", async () => {
  const { api } = client(
    view({ enabled: true, setting: "default", mode: "lcu-v1", groupingException: true }),
  );
  render(<DesktopToolsSection api={api} entry={entry} onChanged={() => {}} />);
  expect(await screen.findByText(en["desktopTools.setting.default"])).toBeTruthy();
  expect(screen.getByText(en["desktopTools.groupingWarning"])).toBeTruthy();
  expect(screen.getByText(en["desktopTools.disable"])).toBeTruthy();
  cleanup();
  const off = client(view());
  render(<DesktopToolsSection api={off.api} entry={entry} onChanged={() => {}} />);
  expect(await screen.findByText(en["desktopTools.setting.chosen"])).toBeTruthy();
  expect(screen.getByText(en["desktopTools.enable"])).toBeTruthy();
  expect(en["desktopTools.intro"]).toContain("on by default");
});

it("states the grouping exception in every locale, naming the ADR", () => {
  for (const messages of [en, es, ja, zhCN, zhTW]) {
    expect(messages["desktopTools.groupingWarning"]).toContain("ADR-0048");
    expect(Object.keys(messages).sort()).toEqual(Object.keys(en).sort());
  }
});

it("saves only the bots that changed", async () => {
  const on = view({ enabled: true, mode: "lcu-v1", groupingException: true });
  const { api, puts } = client(on);
  render(<DesktopToolsSection api={api} entry={entry} onChanged={() => {}} />);
  fireEvent.click(await screen.findByLabelText("vega"));
  fireEvent.click(screen.getByText(en["desktopTools.save"]));
  await waitFor(() => expect(puts).toEqual([{ bots: { bot_vega: true } }]));
});

it("offers no enable button on an image without the capability", async () => {
  const { api } = client(view({ image: "not_capable" }));
  render(<DesktopToolsSection api={api} entry={entry} onChanged={() => {}} />);
  expect(await screen.findByText(en["desktopTools.image.not_capable"])).toBeTruthy();
  expect(screen.queryByText(en["desktopTools.enable"])).toBeNull();
});

it("retries a failed read without enabling desktop tools", async () => {
  const { api, puts } = client(view());
  vi.spyOn(api, "getWorkspaceDesktopTools").mockRejectedValueOnce(new Error("Read unavailable"));
  render(<DesktopToolsSection api={api} entry={entry} onChanged={() => {}} />);
  expect((await screen.findByRole("alert")).textContent).toContain("Read unavailable");
  fireEvent.click(screen.getByRole("button", { name: en["desktopTools.retry"] }));
  expect(await screen.findByText(en["desktopTools.image.capable"])).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(puts).toEqual([]);
});
