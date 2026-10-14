// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import { BOT_ID, WS_ID, fakeFetch } from "../../test-support/fixtures.js";
import { DesktopRail } from "./desktop-rail.js";
vi.mock("./desktop-view.js", () => ({
  DesktopView: ({ mode = "view" }: { mode?: string }) => (
    <div data-testid="desktop-mode">{mode}</div>
  ),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("opens a live view without taking control and explicitly returns the workspace hold", async () => {
  let humanHeld = false;
  const { fetch, calls } = fakeFetch({
    "GET /api/bots/bot_1/screen": () => ({
      botId: BOT_ID,
      workspaceId: WS_ID,
      state: "ready",
      slot: 0,
      humanHeld,
    }),
    "POST /api/workspaces/ws_1/takeover": () => {
      humanHeld = true;
      return {};
    },
    "POST /api/workspaces/ws_1/handback": () => {
      humanHeld = false;
      return {};
    },
  });
  render(
    <DesktopRail
      api={createApiClient({ fetch })}
      workspaceId={WS_ID}
      members={[{ botId: BOT_ID, name: "Alpha" }]}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Open desktop" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByTestId("desktop-mode").textContent).toBe("view");
  expect(calls.some((call) => call.method === "POST")).toBe(false);
  fireEvent.click(within(dialog).getByRole("button", { name: "Take control" }));
  await waitFor(() =>
    expect(within(dialog).getByTestId("desktop-mode").textContent).toBe("control"),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Close desktop" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(humanHeld).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Open desktop" }));
  fireEvent.click(await screen.findByRole("button", { name: "Return control" }));
  await waitFor(() => expect(humanHeld).toBe(false));
  await waitFor(() =>
    expect(within(screen.getByRole("dialog")).getByTestId("desktop-mode").textContent).toBe("view"),
  );
});
it("never starts a stopped workspace from a passive preview; starting is explicit", async () => {
  const { fetch, calls } = fakeFetch({
    "GET /api/bots/bot_1/screen": {
      botId: BOT_ID,
      workspaceId: WS_ID,
      state: "stopped",
      humanHeld: false,
    },
    "POST /api/bots/bot_1/screen/start": {
      botId: BOT_ID,
      workspaceId: WS_ID,
      state: "ready",
      slot: 0,
      humanHeld: false,
    },
  });
  render(
    <DesktopRail
      api={createApiClient({ fetch })}
      workspaceId={WS_ID}
      members={[{ botId: BOT_ID, name: "Alpha" }]}
    />,
  );
  await waitFor(() => expect(calls.some((c) => c.method === "GET")).toBe(true));
  expect(calls.some((c) => c.method === "POST")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Start desktop" }));
  await screen.findByRole("dialog");
  expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([
    "/api/bots/bot_1/screen/start",
  ]);
});

it("can resume an existing human hold without taking it again and keeps remote Escape inside control", async () => {
  const { fetch, calls } = fakeFetch({
    "GET /api/bots/bot_1/screen": {
      botId: BOT_ID,
      workspaceId: WS_ID,
      state: "ready",
      slot: 0,
      humanHeld: true,
    },
  });
  render(
    <DesktopRail
      api={createApiClient({ fetch })}
      workspaceId={WS_ID}
      members={[{ botId: BOT_ID, name: "Alpha" }]}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Open desktop" }));
  const dialog = await screen.findByRole("dialog");
  expect(
    within(dialog).getByText("Live view. Browser work is paused for human control."),
  ).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Resume control" }));
  expect(within(dialog).getByTestId("desktop-mode").textContent).toBe("control");
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(calls.some((c) => c.method === "POST")).toBe(false);
});
