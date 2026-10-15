// @vitest-environment jsdom
// T1 (in-process), issue #111: ChatInfo's X and Escape close the panel, focus returns to the
// header toggle that opened it, and repeated open/close leaves no modal residue (dialog node or
// the body pointer-events lock) over the chat. The hit-test cause (a stacking context painted
// over the X) is CSS; it is measured in a real browser, not here.

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import {
  bot,
  fakeFetch,
  installFakeEventSource,
  members,
  message,
  thread,
  workspace,
  workspaceView,
} from "../../test-support/fixtures.js";
import { shownTurnBudget } from "./chat-info.js";
import { ThreadScreen } from "./thread.js";

function renderChat(detailExtra: Record<string, unknown> = {}) {
  const { fetch } = fakeFetch({
    "GET /api/bots/bot_1/screen": { state: "stopped", humanHeld: false },
    "GET /api/workspaces": { workspaces: [workspace] },
    "GET /api/bots": { bots: [bot] },
    "GET /api/threads?workspaceId=ws_1&limit=50": { threads: [thread] },
    "GET /api/threads/thr_1": { thread, members, ...detailExtra },
    "GET /api/workspaces/ws_1": workspaceView(),
    "GET /api/threads/thr_1/messages": { messages: [message(1, "human", "check the console")] },
    "GET /api/runs?threadId=thr_1": { runs: [] },
    "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
    "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [] },
  });
  return render(<ThreadScreen threadId={thread.id} api={createApiClient({ fetch })} />);
}

const toggle = () => document.getElementById(`chat-info-toggle-${thread.id}`) as HTMLElement;
const infoDialog = () => screen.queryByRole("dialog", { name: "Chat info" });

async function expectClosed() {
  await waitFor(() => expect(infoDialog()).toBeNull());
  expect(document.activeElement).toBe(toggle());
  expect(toggle().getAttribute("aria-pressed")).toBe("false");
  // Radix locks pointer events on <body> while a modal is open; none may be left behind.
  expect(document.body.style.pointerEvents).not.toBe("none");
  expect(localStorage.getItem("deskmates.showChatInfo")).toBe("0");
}

describe("ChatInfo close (#111)", () => {
  beforeEach(() => {
    localStorage.setItem("deskmates.showChatInfo", "1");
    installFakeEventSource();
  });
  afterEach(() => {
    cleanup();
    localStorage.removeItem("deskmates.showChatInfo");
    vi.restoreAllMocks();
  });

  it("closes from the X and returns focus to the toggle", async () => {
    renderChat();
    const dialog = await screen.findByRole("dialog", { name: "Chat info" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Hide chat info" }));
    await expectClosed();
  });

  it("closes on Escape and survives repeated open and close", async () => {
    renderChat();
    await screen.findByRole("dialog", { name: "Chat info" });
    for (let round = 0; round < 3; round += 1) {
      const dialog = infoDialog() as HTMLElement;
      if (round % 2 === 0) fireEvent.keyDown(dialog, { key: "Escape" });
      else fireEvent.click(within(dialog).getByRole("button", { name: "Hide chat info" }));
      await expectClosed();
      fireEvent.click(toggle());
      await screen.findByRole("dialog", { name: "Chat info" });
    }
    fireEvent.keyDown(infoDialog() as HTMLElement, { key: "Escape" });
    await expectClosed();
    // The chat underneath is usable again.
    expect(screen.getByLabelText("Message")).toBeTruthy();
  });
});

describe("ChatInfo turn budget (ADR-0005 amendment 5 decision 38)", () => {
  beforeEach(() => {
    localStorage.setItem("deskmates.showChatInfo", "1");
    installFakeEventSource();
  });
  afterEach(() => {
    cleanup();
    localStorage.removeItem("deskmates.showChatInfo");
    vi.restoreAllMocks();
  });

  it("shows the workspace's effective budget, not the thread row's", async () => {
    renderChat({ effectiveTurnBudget: { value: 20, source: "workspace" } });
    const dialog = await screen.findByRole("dialog", { name: "Chat info" });
    expect(within(dialog).getByText(/Turn budget 20/)).toBeTruthy();
    expect(within(dialog).queryByText(/Turn budget 8/)).toBeNull();
  });

  it("says off when the workspace turned the budget off, and falls back to the row", () => {
    const detail = { thread, members };
    expect(
      shownTurnBudget(
        { ...detail, effectiveTurnBudget: { value: null, source: "workspace" } },
        "Off",
      ),
    ).toBe("Off");
    expect(
      shownTurnBudget({ ...detail, effectiveTurnBudget: { value: 8, source: "thread" } }, "Off"),
    ).toBe(8);
    expect(shownTurnBudget(detail, "Off")).toBe(thread.turnBudget);
  });
});
