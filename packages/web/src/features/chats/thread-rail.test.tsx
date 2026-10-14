// @vitest-environment jsdom
// T0, ADR-0022 amendment 7 S6 and S7: below Admin, a bot's entry in the chat list is the
// viewer's own private chat with it, created by the first click, while the bot's shared
// canonical chat moves under the entry's earlier chats; an Admin's entry stays the canonical chat.
// Nobody below Admin is offered the new-chat dialog, which creates only Admin things.
import "@testing-library/jest-dom/vitest";
import type { SessionRoles, ThreadSummary } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
