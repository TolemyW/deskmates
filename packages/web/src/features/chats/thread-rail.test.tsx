// @vitest-environment jsdom
// T0, ADR-0022 amendment 7 S6 and S7: below Admin, a bot's entry in the chat list is the
// viewer's own private chat with it, created by the first click, while the bot's shared
// canonical chat moves under the entry's earlier chats; an Admin's entry stays the canonical chat.
// Nobody below Admin is offered the new-chat dialog, which creates only Admin things.
import "@testing-library/jest-dom/vitest";
import type { SessionRoles, ThreadSummary } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import { SessionRolesProvider } from "../../state/session-roles.js";
import { WS_ID, bot, fakeFetch, members, thread, workspace } from "../../test-support/fixtures.js";
import { ThreadRail, railSections } from "./thread-rail.js";

const ME = "user:usr_mel";

const canonical: ThreadSummary = {
  ...thread,
  id: "thr_canonical" as never,
  title: undefined as never,
  privateChatBotId: bot.id,
  memberIds: [bot.id],
  updatedAt: "2026-10-14T09:00:00.000Z",
};
const mine: ThreadSummary = {
  ...thread,
  id: "thr_mine" as never,
  privateToUserId: "usr_mel",
  sideChatActor: ME,
  memberIds: [bot.id],
  updatedAt: "2026-10-14T08:00:00.000Z",
};

function as(role: "member" | "admin" | "guest", ui: ReactNode) {
  const roles: SessionRoles = {
    tenantRole: role,
    platformMaintainer: false,
    workspaceRoles: { [WS_ID]: role },
  };
  return render(
    <SessionRolesProvider roles={roles} actorId={ME}>
      {ui}
    </SessionRolesProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.location.hash = "";
});

describe("a bot's entry in the chat list (amendment 7 S7)", () => {
  it("a Member's bot entry is their own private chat; the canonical chat is an earlier one", () => {
    const sections = railSections([bot], [canonical, mine], ME);
    expect(sections.inboxes[0]?.thread?.id).toBe("thr_mine");
    expect(sections.inboxes[0]?.earlier.map((t) => t.id)).toEqual(["thr_canonical"]);
    // An Admin's entry stays the canonical chat.
    expect(railSections([bot], [canonical, mine]).inboxes[0]?.thread?.id).toBe("thr_canonical");
  });

  it("a Member without a chat of their own opens a new one, never the canonical chat", async () => {
    const created = { ...mine, id: "thr_new" as never };
    const { fetch, calls } = fakeFetch({
      "POST /api/threads": { thread: created, members },
      "POST /api/bots/bot_1/private-chat": { thread: canonical, members },
    });
    as(
      "member",
      <ThreadRail
        workspace={workspace}
        bots={[bot]}
        threads={[canonical]}
        onCreated={() => {}}
        api={createApiClient({ fetch })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: `Private chat with ${bot.name}` }));
    await waitFor(() => expect(window.location.hash).toBe("#/threads/thr_new"));
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /api/threads"]);
  });

  it("a Guest's entry opens their inquiry even when the canonical chat exists", async () => {
    const { fetch, calls } = fakeFetch({ "POST /api/threads": { thread: mine, members } });
    as(
      "guest",
      <ThreadRail
        workspace={workspace}
        bots={[bot]}
        threads={[canonical]}
        onCreated={() => {}}
        api={createApiClient({ fetch })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: `Private chat with ${bot.name}` }));
    await waitFor(() => expect(window.location.hash).toBe("#/threads/thr_mine"));
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /api/threads"]);
  });

  it("only an Admin is offered the new-chat dialog (S6)", () => {
    const { fetch } = fakeFetch({});
    const rail = (role: "member" | "admin" | "guest") =>
      as(
        role,
        <ThreadRail
          workspace={workspace}
          bots={[bot]}
          threads={[canonical]}
          onCreated={() => {}}
          api={createApiClient({ fetch })}
        />,
      );
    rail("member");
    expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();
    cleanup();
    rail("guest");
    expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();
    cleanup();
    rail("admin");
    expect(screen.getByRole("button", { name: "New chat" })).toBeInTheDocument();
  });
});

describe("chat preview authors (issue #22 E6)", () => {
  const peer = { ...bot, id: "bot_peer" as never, name: "peer" };
  const group: ThreadSummary = {
    ...thread,
    id: "thr_group" as never,
    title: "Team",
    memberIds: [bot.id, peer.id],
    lastMessage: {
      seq: 1,
      authorKind: "human",
      authorId: "user:usr_owner",
      authorName: "Olive Owner",
      excerpt: "@ops please re-run the check",
      ts: "2026-10-17T10:00:00.000Z",
    },
  };

  it("says You only for the signed-in person's own message", () => {
    const lastMessage = group.lastMessage;
    if (!lastMessage) throw new Error("test fixture needs a last message");
    as(
      "member",
      <ThreadRail
        workspace={workspace}
        bots={[bot, peer]}
        threads={[group]}
        onCreated={() => {}}
      />,
    );
    expect(screen.getByText("Olive Owner:")).toBeInTheDocument();
    expect(screen.queryByText("You:")).toBeNull();
    cleanup();
    as(
      "member",
      <ThreadRail
        workspace={workspace}
        bots={[bot, peer]}
        threads={[
          {
            ...group,
            lastMessage: { ...lastMessage, authorId: ME, authorName: "Mel" },
          },
        ]}
        onCreated={() => {}}
      />,
    );
    expect(screen.getByText("You:")).toBeInTheDocument();
    expect(screen.queryByText("Mel:")).toBeNull();
  });
});

describe("the first-run form (ADR-0051 decision 11)", () => {
  it("creates the workspace without a bot and opens the assistant's chat", async () => {
    const assistant = { ...bot, id: "bot_assistant" as never, name: "assistant" };
    const privateChat = { ...thread, id: "thr_assistant" as never };
    const { fetch, calls } = fakeFetch({
      "POST /api/workspaces": {
        workspace: { ...workspace, defaultBotId: assistant.id },
        defaultBot: assistant,
        privateChat,
      },
    });
    const onCreated = vi.fn();
    as(
      "admin",
      <ThreadRail
        workspace={undefined}
        bots={[]}
        threads={[]}
        onCreated={onCreated}
        api={createApiClient({ fetch })}
      />,
    );
    expect(screen.queryByLabelText("Bot name")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(onCreated.mock.calls[0]?.[0]).toMatchObject({
      thread: { id: "thr_assistant" },
      bot: { id: "bot_assistant" },
      workspace: { defaultBotId: "bot_assistant" },
    });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(["POST /api/workspaces"]);
  });
});

describe("the New chat dialog with fewer than two bots (ADR-0051)", () => {
  it("offers the assistant's chat and New bot, and no form that cannot be sent", async () => {
    const { fetch } = fakeFetch({
      "POST /api/bots/bot_1/private-chat": { thread: canonical, members },
    });
    as(
      "admin",
      <ThreadRail
        workspace={{ ...workspace, defaultBotId: bot.id }}
        bots={[bot]}
        threads={[canonical]}
        onCreated={() => {}}
        api={createApiClient({ fetch })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByLabelText("Title (optional)")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Create chat" })).toBeNull();
    expect(within(dialog).getByRole("link", { name: "New bot" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: `Chat with ${bot.name}` }));
    await waitFor(() => expect(window.location.hash).toBe("#/threads/thr_canonical"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
