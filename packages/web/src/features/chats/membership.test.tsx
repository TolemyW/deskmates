// @vitest-environment jsdom
// T1: editing a conversation's bot membership changes its header and desktop cards without
// posting a chat message. The Gateway remains authoritative when another tab edits membership.

import type { BotDefinition, BotId, ThreadId } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import {
  FakeEventSource,
  THREAD_ID,
  bot,
  fakeFetch,
  installFakeEventSource,
  members,
  message,
  thread,
  workspace,
  workspaceView,
} from "../../test-support/fixtures.js";
import { ThreadScreen } from "./thread.js";

const reviewer: BotDefinition = {
  ...bot,
  id: "bot_2" as BotId,
  name: "reviewer",
  role: "review",
};
const auditor: BotDefinition = {
  ...bot,
  id: "bot_3" as BotId,
  name: "auditor",
  role: "audit",
};
const outside: BotDefinition = {
  ...bot,
  id: "bot_outside" as BotId,
  name: "outside",
  workspaceId: "ws_other" as typeof workspace.id,
};
const firstMember = members[0];
if (!firstMember) throw new Error("missing member fixture");
const reviewerMember = { ...firstMember, botId: reviewer.id, name: reviewer.name };
const auditorMember = { ...firstMember, botId: auditor.id, name: auditor.name };

/** Name of the member whose chip carries the owner mark, if any. */
function ownerOf(list: HTMLElement): string | undefined {
  const badge = within(list).queryByText("owner");
  return badge?.closest("li")?.querySelector(".member-name")?.textContent ?? undefined;
}

function routes(extra: Record<string, unknown> = {}) {
  return {
    "GET /api/bots/bot_1/screen": { state: "stopped", humanHeld: false },
    "GET /api/bots/bot_2/screen": { state: "stopped", humanHeld: false },
    "GET /api/bots/bot_3/screen": { state: "stopped", humanHeld: false },
    "GET /api/workspaces": { workspaces: [workspace] },
    "GET /api/bots": { bots: [bot, reviewer, auditor, outside] },
    "GET /api/bots?workspaceId=ws_1": { bots: [bot, reviewer, auditor] },
    "GET /api/threads?workspaceId=ws_1&limit=50": { threads: [thread] },
    "GET /api/threads/thr_1": { thread, members },
    "GET /api/workspaces/ws_1": workspaceView({ bots: [bot, reviewer, auditor] }),
    "GET /api/threads/thr_1/messages": { messages: [] },
    "GET /api/runs?threadId=thr_1": { runs: [] },
    "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
    "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [] },
    ...extra,
  };
}

describe("conversation membership", () => {
  beforeEach(() => {
    installFakeEventSource();
    localStorage.setItem("deskmates.showChatInfo", "1");
    window.location.hash = "";
  });
  afterEach(() => {
    cleanup();
    localStorage.removeItem("deskmates.showChatInfo");
    vi.restoreAllMocks();
  });

  it("adds selected same-workspace bots and updates member and desktop views without waking bots", async () => {
    let currentMembers = [...members];
    const { fetch, calls } = fakeFetch(
      routes({
        "GET /api/threads/thr_1": () => ({ thread, members: currentMembers }),
        "POST /api/threads/thr_1/members": () => {
          currentMembers = [...members, reviewerMember];
          return { thread, members: currentMembers };
        },
      }),
    );
    render(<ThreadScreen threadId={THREAD_ID} api={createApiClient({ fetch })} />);
    await screen.findByRole("button", { name: "Add bot" });
    fireEvent.click(screen.getByRole("button", { name: "Add bot" }));
    const dialog = await screen.findByRole("dialog", { name: "Add bots to chat" });
    await within(dialog).findByLabelText("Search bots");
    expect(within(dialog).queryByText("outside")).toBeNull();
    expect(within(dialog).queryByRole("checkbox", { name: /ops/ })).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("Search bots"), {
      target: { value: "review" },
    });
    expect(within(dialog).queryByText("auditor")).toBeNull();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /reviewer/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add selected bots" }));

    await waitFor(() =>
      expect(within(screen.getByLabelText("Chat members")).getByText("reviewer")).toBeTruthy(),
    );
    expect(
      within(screen.getByLabelText("Bot desktops")).getByRole("heading", { name: "reviewer" }),
    ).toBeTruthy();
    expect(calls.filter((call) => call.method === "POST")).toEqual([
      { method: "POST", path: "/api/threads/thr_1/members", body: { botIds: [reviewer.id] } },
    ]);
  });

  it("removes a member from current views while retaining its name on historical messages", async () => {
    let currentMembers = [...members, reviewerMember];
    const { fetch, calls } = fakeFetch(
      routes({
        "GET /api/threads/thr_1": () => ({ thread, members: currentMembers }),
        "GET /api/threads/thr_1/messages": {
          messages: [message(1, "bot", "Earlier review", { authorId: reviewer.id })],
        },
        "DELETE /api/threads/thr_1/members/bot_2": () => {
          currentMembers = [...members];
          return { thread, members };
        },
      }),
    );
    render(<ThreadScreen threadId={THREAD_ID} api={createApiClient({ fetch })} />);
    await screen.findByText("Earlier review");
    const transcript = screen.getByLabelText("Transcript");
    expect(within(transcript).getByText("reviewer")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove reviewer from chat" }));
    await waitFor(() =>
      expect(within(screen.getByLabelText("Chat members")).queryByText("reviewer")).toBeNull(),
    );
    expect(
      within(screen.getByLabelText("Bot desktops")).queryByRole("heading", { name: "reviewer" }),
    ).toBeNull();
    expect(within(transcript).getByText("reviewer")).toBeTruthy();
    expect(calls.filter((call) => call.method !== "GET")).toEqual([
      { method: "DELETE", path: "/api/threads/thr_1/members/bot_2", body: undefined },
    ]);
  });

  it("keeps the sole member and preserves membership after a busy removal conflict", async () => {
    const { fetch: baseFetch, calls } = fakeFetch(
      routes({
        "GET /api/threads/thr_1": { thread, members: [...members, reviewerMember] },
        "DELETE /api/threads/thr_1/members/bot_2": {},
      }),
    );
    const fetch: typeof baseFetch = async (input, init) => {
      const response = await baseFetch(input, init);
      if (init?.method !== "DELETE") return response;
      return new Response(
        JSON.stringify({
          code: "invalid_transition",
          message: "member has an active run",
          details: {},
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    };
    render(<ThreadScreen threadId={THREAD_ID} api={createApiClient({ fetch })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Manage" }));
    await screen.findByRole("button", { name: "Remove reviewer from chat" });
    expect(screen.queryByRole("button", { name: "Remove ops from chat" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove reviewer from chat" }));
    await screen.findByText(/member has an active run/);
    expect(within(screen.getByLabelText("Chat members")).getByText("reviewer")).toBeTruthy();
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
  });

  it("disables removal of the last member and addition when a conversation reaches six bots", async () => {
    const sixMembers = Array.from({ length: 6 }, (_, index) => ({
      ...firstMember,
      botId: `bot_${index + 1}` as BotId,
      name: `member${index + 1}`,
    }));
    const { fetch, calls } = fakeFetch(
      routes({
        "GET /api/threads/thr_1": () => ({ thread, members: sixMembers }),
      }),
    );
    const api = createApiClient({ fetch });
    const view = render(<ThreadScreen threadId={THREAD_ID} api={api} />);
    const fullAdd = await screen.findByRole("button", { name: "Add bot" });
    expect((fullAdd as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(fullAdd);
    expect(screen.queryByRole("dialog", { name: "Add bots to chat" })).toBeNull();

    view.unmount();
    const sole = fakeFetch(routes());
    render(<ThreadScreen threadId={THREAD_ID} api={createApiClient({ fetch: sole.fetch })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Manage" }));
    const lastRemove = await screen.findByRole("button", {
      name: "Remove ops from chat",
    });
    expect((lastRemove as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(lastRemove);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    expect(sole.calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("refreshes membership on a frame from another operator tab", async () => {
    let currentMembers = members;
    const { fetch, calls } = fakeFetch(
      routes({
        "GET /api/threads/thr_1": () => ({ thread, members: currentMembers }),
      }),
    );
    render(<ThreadScreen threadId={THREAD_ID} api={createApiClient({ fetch })} />);
    await screen.findByRole("button", { name: "Add bot" });
    currentMembers = [...members, auditorMember];
    FakeEventSource.forUrl(`/api/events?threadId=${THREAD_ID}`).emit({
      type: "thread_members",
      threadId: THREAD_ID,
    });
    await waitFor(() =>
      expect(within(screen.getByLabelText("Chat members")).getByText("auditor")).toBeTruthy(),
    );
    expect(
      within(screen.getByLabelText("Bot desktops")).getByRole("heading", { name: "auditor" }),
    ).toBeTruthy();
    expect(calls.some((call) => call.method !== "GET")).toBe(false);
  });

  it("shows bus thread members without chat membership controls", async () => {
    const busThread = { ...thread, kind: "bus" as const };
    const { fetch } = fakeFetch(
      routes({
        "GET /api/threads?workspaceId=ws_1&limit=50": { threads: [busThread] },
        "GET /api/threads/thr_1": {
          thread: busThread,
          members: [...members, reviewerMember],
        },
      }),
    );
    render(<ThreadScreen threadId={THREAD_ID} api={createApiClient({ fetch })} />);
    const memberList = await screen.findByLabelText("Chat members");
    expect(within(memberList).getByText("ops")).toBeTruthy();
    expect(within(memberList).getByText("reviewer")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add bot" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove .* from chat/ })).toBeNull();
  });

  it("drops a selected bot when another tab adds it, leaving other candidates selectable", async () => {
    let currentMembers = [...members];
    const { fetch, calls } = fakeFetch(
      routes({
        "GET /api/threads/thr_1": () => ({ thread, members: currentMembers }),
        "POST /api/threads/thr_1/members": () => {
          currentMembers = [...currentMembers, auditorMember];
          return { thread, members: currentMembers };
        },
      }),
    );
    render(<ThreadScreen threadId={THREAD_ID} api={createApiClient({ fetch })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add bot" }));
    const dialog = await screen.findByRole("dialog", { name: "Add bots to chat" });
    fireEvent.click(await within(dialog).findByRole("checkbox", { name: /reviewer/ }));
    expect(
      (within(dialog).getByRole("button", { name: "Add selected bots" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    currentMembers = [...members, reviewerMember];
    FakeEventSource.forUrl(`/api/events?threadId=${THREAD_ID}`).emit({
      type: "thread_members",
      threadId: THREAD_ID,
    });
    await waitFor(() =>
      expect(within(dialog).queryByRole("checkbox", { name: /reviewer/ })).toBeNull(),
    );
    expect(
      (within(dialog).getByRole("button", { name: "Add selected bots" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /auditor/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add selected bots" }));
    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true));
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({ botIds: [auditor.id] });
  });

  it("marks the owner of a group under owner-v1 and moves the mark on a thread_members frame", async () => {
    let current = { ...thread, ownerBotId: reviewer.id };
    const { fetch } = fakeFetch(
      routes({
        "GET /api/threads/thr_1": () => ({
          thread: current,
          members: [...members, reviewerMember, auditorMember],
          groupRouting: "owner-v1",
        }),
      }),
    );
    render(<ThreadScreen threadId={THREAD_ID} api={createApiClient({ fetch })} />);
    const list = await screen.findByLabelText("Chat members");
    await waitFor(() => expect(ownerOf(list)).toBe("reviewer"));
    const badge = within(list).getByText("owner");
    expect(badge.getAttribute("title")).toBe(
      "Took the latest unaddressed request; offered the next one first",
    );
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "any update?" } });
    expect(
      screen.getByText(
        "No @mention: offered to @reviewer first, then to the other members until one replies",
      ),
    ).toBeTruthy();

    current = { ...thread, ownerBotId: auditor.id };
    FakeEventSource.forUrl(`/api/events?threadId=${THREAD_ID}`).emit({
      type: "thread_members",
      threadId: THREAD_ID,
    });
    await waitFor(() => expect(ownerOf(list)).toBe("auditor"));
    expect(within(list).getAllByText("owner")).toHaveLength(1);
    expect(
      screen.getByText(
        "No @mention: offered to @auditor first, then to the other members until one replies",
      ),
    ).toBeTruthy();
  });

  it("shows no owner mark without an owner, in a one-member thread, or under walk-v1", async () => {
    const cases = [
      {
        thread,
        members: [...members, reviewerMember],
        groupRouting: "owner-v1",
        preview: "No @mention: offered to one member at a time until one replies",
      },
      {
        thread: { ...thread, ownerBotId: firstMember.botId },
        members,
        groupRouting: "owner-v1",
        preview: "No @mention: every member is woken in turn",
      },
      {
        thread: { ...thread, ownerBotId: reviewer.id },
        members: [...members, reviewerMember],
        groupRouting: "walk-v1",
        preview: "No @mention: every member is woken in turn",
      },
      // An older Gateway omits groupRouting: it walks every member.
      {
        thread: { ...thread, ownerBotId: reviewer.id },
        members: [...members, reviewerMember],
        preview: "No @mention: every member is woken in turn",
      },
    ];
    for (const { preview, ...detail } of cases) {
      const { fetch } = fakeFetch(routes({ "GET /api/threads/thr_1": detail }));
      render(<ThreadScreen threadId={THREAD_ID} api={createApiClient({ fetch })} />);
      const list = await screen.findByLabelText("Chat members");
      await within(list).findByText(detail.members.at(-1)?.name ?? "");
      fireEvent.change(screen.getByLabelText("Message"), { target: { value: "any update?" } });
      await screen.findByText(preview);
      expect(within(list).queryByText("owner")).toBeNull();
      cleanup();
    }
  });

  it("does not apply a late membership response after switching conversations", async () => {
    const secondId = "thr_2" as ThreadId;
    const secondThread = { ...thread, id: secondId, title: "Other conversation" };
    let resolveAdd: ((value: unknown) => void) | undefined;
    const { fetch } = fakeFetch(
      routes({
        "GET /api/threads?workspaceId=ws_1&limit=50": { threads: [thread, secondThread] },
        "GET /api/threads/thr_2": {
          thread: secondThread,
          members: [{ ...firstMember, threadId: secondId }],
        },
        "GET /api/threads/thr_2/messages": { messages: [] },
        "GET /api/runs?threadId=thr_2": { runs: [] },
        "GET /api/approvals?status=pending&threadId=thr_2": { approvals: [] },
        "GET /api/approvals?status=decided&threadId=thr_2": { approvals: [] },
        "POST /api/threads/thr_1/members": () =>
          new Promise((resolve) => {
            resolveAdd = resolve;
          }),
      }),
    );
    const api = createApiClient({ fetch });
    const view = render(<ThreadScreen threadId={THREAD_ID} api={api} />);
    await screen.findByRole("button", { name: "Add bot" });
    fireEvent.click(screen.getByRole("button", { name: "Add bot" }));
    const dialog = await screen.findByRole("dialog", { name: "Add bots to chat" });
    fireEvent.click(await within(dialog).findByRole("checkbox", { name: /reviewer/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add selected bots" }));
    view.rerender(<ThreadScreen threadId={secondId} api={api} />);
    expect(await screen.findAllByRole("heading", { name: "Other conversation" })).not.toHaveLength(
      0,
    );
    resolveAdd?.({ thread, members: [...members, reviewerMember] });
    await Promise.resolve();
    expect(within(screen.getByLabelText("Chat members")).queryByText("reviewer")).toBeNull();
  });
});
