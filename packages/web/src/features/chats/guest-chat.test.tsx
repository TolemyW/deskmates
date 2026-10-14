// @vitest-environment jsdom
// T0, ADR-0022 amendment 6 W6 and W11: a Guest reads the workspace's shared chats with a
// read-only notice where the composer would be, and asks no runs or approvals, which the Gateway
// refuses them. Their own private inquiry says that status answers are not available yet, and a
// click on a bot opens that inquiry through `POST /api/threads`, never the bot's canonical chat.
import "@testing-library/jest-dom/vitest";
import type { SessionRoles } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import { SessionRolesProvider } from "../../state/session-roles.js";
import {
  THREAD_ID,
  WS_ID,
  bot,
  fakeFetch,
  installFakeEventSource,
  members,
  message,
  thread,
  workspace,
  workspaceView,
} from "../../test-support/fixtures.js";
import { ChatPane } from "./chat-pane.js";
import { ThreadRail } from "./thread-rail.js";

const GUEST: SessionRoles = {
  tenantRole: "guest",
  platformMaintainer: false,
  workspaceRoles: { [WS_ID]: "guest" },
};
const ME_ID = "usr_guest";

function as(ui: ReactNode) {
  return render(
    <SessionRolesProvider roles={GUEST} actorId={`user:${ME_ID}`}>
      {ui}
    </SessionRolesProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.location.hash = "";
});

function renderChat(detail: { thread: typeof thread }) {
  const { fetch, calls } = fakeFetch({
    [`GET /api/threads/${THREAD_ID}`]: { ...detail, members },
    [`GET /api/threads/${THREAD_ID}/messages`]: { messages: [message(1, "human", "hello")] },
    [`GET /api/workspaces/${WS_ID}`]: workspaceView(),
  });
  as(<ChatPane threadId={THREAD_ID} api={createApiClient({ fetch })} />);
  return calls;
}

describe("a Guest in chats", () => {
  beforeEach(() => installFakeEventSource());

  it("a Guest reads a shared chat without a composer", async () => {
    const calls = renderChat({ thread });
    await screen.findByText("hello");
    expect(await screen.findByTestId("guest-notice")).toHaveTextContent(
      "Guests can read this chat but not post in it.",
    );
    expect(screen.queryByTestId("composer-locked")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Message", hidden: true })).not.toBeVisible();
    // Runs and approvals are refused to a Guest, so the pane never asks for them.
    expect(calls.some((call) => call.path.startsWith("/api/runs"))).toBe(false);
    expect(calls.some((call) => call.path.startsWith("/api/approvals"))).toBe(false);
  });

  it("a Guest asks in their own inquiry and is told what the answer may use (amendment 7)", async () => {
    const inquiry = { ...thread, privateToUserId: ME_ID, sideChatActor: `user:${ME_ID}` };
    const { fetch, calls } = fakeFetch({
      [`GET /api/threads/${THREAD_ID}`]: { thread: inquiry, members },
      [`GET /api/threads/${THREAD_ID}/messages`]: { messages: [message(1, "human", "hello")] },
      [`GET /api/workspaces/${WS_ID}`]: workspaceView(),
      [`POST /api/threads/${THREAD_ID}/messages`]: {
        message: message(2, "human", "what is the status?"),
        runs: [{ id: "run_job", status: "queued", threadId: THREAD_ID, botId: bot.id }],
      },
    });
    as(<ChatPane threadId={THREAD_ID} api={createApiClient({ fetch })} />);
    await screen.findByText("hello");
    expect(screen.queryByTestId("guest-notice")).toBeNull();
    expect(screen.getByTestId("inquiry-scope")).toHaveTextContent(
      "Answers use only what Guests can read here",
    );
    const box = screen.getByRole("textbox", { name: "Message" });
    expect(box).toBeVisible();
    fireEvent.change(box, { target: { value: "what is the status?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("what is the status?");
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/messages"))).toBe(true);
    // The status job is no run the Guest reads: the pane asks for no run or approval.
    expect(calls.some((call) => call.path.startsWith("/api/runs"))).toBe(false);
    expect(calls.some((call) => call.path.startsWith("/api/approvals"))).toBe(false);
  });

  it("a Guest's click on a bot opens their own inquiry, never the canonical chat", async () => {
    const created = {
      ...thread,
      id: "thr_inquiry" as never,
      privateToUserId: ME_ID,
      sideChatActor: `user:${ME_ID}`,
    };
    const { fetch, calls } = fakeFetch({
      "POST /api/bots/bot_1/private-chat": { thread, members },
      "POST /api/threads": { thread: created, members },
    });
    as(
      <ThreadRail
        workspace={workspace}
        bots={[bot]}
        threads={[]}
        onCreated={() => {}}
        api={createApiClient({ fetch })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: `Private chat with ${bot.name}` }));
    await waitFor(() => expect(window.location.hash).toBe("#/threads/thr_inquiry"));
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /api/threads"]);
    expect(calls[0]?.body).toEqual({ workspaceId: WS_ID, botIds: [bot.id] });
  });
});
