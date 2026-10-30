// @vitest-environment jsdom
// T0, ADR-0022 amendment 1 ("Admins own the group; Members use side chats", issue #14 item 2):
// each screen hides or disables what a Member may no longer do and names who can, and offers
// an Admin the same controls as before. The Gateway still decides; these tests prove only that
// the UI does not offer what it would refuse.
import "@testing-library/jest-dom/vitest";
import type { SessionRoles, ThreadSummary } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "./api/client.js";
import type { LearnedMemoryEntry } from "./api/client.js";
import type { NamedThreadMember } from "./api/types.js";
import { ApprovalCard } from "./features/approvals/approval-card.js";
import { ChatPane } from "./features/chats/chat-pane.js";
import { ThreadMembership } from "./features/chats/thread-membership.js";
import { ThreadRail } from "./features/chats/thread-rail.js";
import { type LearnedMemoryApi, LearnedMemoryScreen } from "./features/knowledge/learned-memory.js";
import { RunScreen } from "./features/runs/run.js";
import { TasksScreen } from "./features/tasks/tasks.js";
import { SessionRolesProvider } from "./state/session-roles.js";
import {
  type RouteTable,
  THREAD_ID,
  WS_ID,
  approval,
  bot,
  fakeFetch,
  installFakeEventSource,
  members,
  message,
  run,
  thread,
  workspace,
  workspaceView,
} from "./test-support/fixtures.js";

const MEMBER: SessionRoles = { tenantRole: "member", platformMaintainer: false };
const ADMIN: SessionRoles = { tenantRole: "admin", platformMaintainer: false };
const ME = "user:usr_me";

function as(roles: SessionRoles, ui: ReactNode) {
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

const second: NamedThreadMember = {
  ...members[0],
  botId: "bot_2" as never,
  name: "second",
} as NamedThreadMember;

function chatRoutes(detail: { thread: typeof thread; members: NamedThreadMember[] }): RouteTable {
  return {
    "GET /api/threads/thr_1": detail,
    "GET /api/threads/thr_1/messages": { messages: [message(1, "human", "hello")] },
    "GET /api/runs?threadId=thr_1": { runs: [] },
    "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
    "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [] },
    "GET /api/workspaces/ws_1": workspaceView(),
  };
}

function renderChat(roles: SessionRoles, detail: Parameters<typeof chatRoutes>[0]) {
  const { fetch } = fakeFetch(chatRoutes(detail));
  return as(roles, <ChatPane threadId={THREAD_ID} api={createApiClient({ fetch })} />);
}

describe("the composer", () => {
  beforeEach(() => installFakeEventSource());

  // ADR-0022 amendment 6 W5: a Member posts in the workspace's shared `chat` threads.
  it("a Member posts in a group chat", async () => {
    renderChat(MEMBER, { thread, members: [members[0] as NamedThreadMember, second] });
    await screen.findByText("hello");
    await waitFor(() => expect(screen.queryByTestId("composer-locked")).toBeNull());
    expect(screen.getByRole("textbox", { name: "Message" })).toBeVisible();
  });

  it("a Member posts in a bot's shared one-bot chat", async () => {
    renderChat(MEMBER, { thread, members });
    await screen.findByText("hello");
    await waitFor(() => expect(screen.queryByTestId("composer-locked")).toBeNull());
  });

  it("a Member cannot post in a bus thread and is told who can", async () => {
    renderChat(MEMBER, { thread: { ...thread, kind: "bus" }, members: [...members, second] });
    const locked = await screen.findByTestId("composer-locked");
    expect(locked).toHaveTextContent("Only an Admin or Owner can post in this chat.");
    expect(screen.getByRole("textbox", { name: "Message", hidden: true })).not.toBeVisible();
  });

  it("a Member posts in their own side chat", async () => {
    renderChat(MEMBER, { thread: { ...thread, sideChatActor: ME }, members });
    await screen.findByText("hello");
    await waitFor(() => expect(screen.queryByTestId("composer-locked")).toBeNull());
    expect(screen.getByRole("textbox", { name: "Message" })).toBeVisible();
  });

  it("an Admin posts in a group chat", async () => {
    renderChat(ADMIN, { thread, members: [members[0] as NamedThreadMember, second] });
    await screen.findByText("hello");
    expect(screen.queryByTestId("composer-locked")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeVisible();
  });
});

describe("approval answers (C1/C3)", () => {
  it("a Member allows once or denies; Always is an Admin's", () => {
    as(MEMBER, <ApprovalCard approval={approval()} />);
    expect(screen.getByRole("button", { name: "Allow once" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Always" })).toBeNull();
    expect(screen.getByText("Only an Admin or Owner can always allow an action.")).toBeVisible();
  });

  it("a Member cannot allow a new site", () => {
    as(
      MEMBER,
      <ApprovalCard
        approval={approval({
          kind: "egress",
          action: {
            toolName: "mcp__browser__browser_navigate",
            input: { url: "https://new.example.org/" },
            targetOrigin: "https://new.example.org",
          },
        })}
      />,
    );
    expect(screen.queryByRole("button", { name: /Allow this site/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
    expect(screen.getByText("Only an Admin or Owner can allow a new site.")).toBeVisible();
  });

  it("an Admin sees Always and Allow this site, with no role note", () => {
    as(ADMIN, <ApprovalCard approval={approval()} />);
    expect(screen.getByRole("button", { name: "Always" })).toBeInTheDocument();
    cleanup();
    as(
      ADMIN,
      <ApprovalCard
        approval={approval({
          kind: "egress",
          action: {
            toolName: "mcp__browser__browser_navigate",
            input: { url: "https://new.example.org/" },
            targetOrigin: "https://new.example.org",
          },
        })}
      />,
    );
    expect(screen.getByRole("button", { name: /Allow this site/ })).toBeInTheDocument();
    expect(screen.queryByText(/^Only .+ can .+\.$/)).toBeNull();
  });
});

describe("tasks", () => {
  function tasksApi() {
    return createApiClient({
      fetch: fakeFetch({
        "GET /api/workspaces": { workspaces: [workspace] },
        [`GET /api/bots?workspaceId=${WS_ID}`]: { bots: [bot] },
        [`GET /api/workspaces/${WS_ID}/tasks?offset=0&limit=25`]: {
          tasks: [],
          offset: 0,
          limit: 25,
          total: 0,
          statusCounts: {
            planned: 0,
            in_progress: 0,
            blocked: 0,
            delivered: 0,
            accepted: 0,
            cancelled: 0,
          },
        },
      }).fetch,
    });
  }

  it("a Member reads tasks but is offered no New task", async () => {
    as(MEMBER, <TasksScreen api={tasksApi()} />);
    await screen.findByText("No tasks yet.");
    expect(screen.queryByRole("link", { name: /New task/ })).toBeNull();
  });

  it("an Admin is offered New task", async () => {
    as(ADMIN, <TasksScreen api={tasksApi()} />);
    await screen.findByText("No tasks yet.");
    expect(screen.getByRole("link", { name: /New task/ })).toBeInTheDocument();
  });
});

describe("learned memory (C2)", () => {
  function memoryApi() {
    const entry = {
      id: "mem_1",
      workspaceId: "ws_1",
      scope: "workspace",
      kind: "note",
      body: "The quota page lists 40 seats.",
      authority: "fact",
      trust: "untrusted",
      sourceKind: "page",
      derivedFrom: [],
      observedAt: "2026-09-26T12:00:00.000Z",
      validFrom: "2026-09-26T12:00:00.000Z",
      version: 2,
      tombstoned: false,
      live: true,
    } as unknown as LearnedMemoryEntry;
    const api = {
      listWorkspaces: vi.fn(async () => [{ id: "ws_1", name: "ops" }]),
      listBots: vi.fn(async () => []),
      listRuns: vi.fn(async () => []),
      listThreads: vi.fn(async () => []),
      searchLearnedMemory: vi.fn(async () => []),
      listMemoryEntriesPage: vi.fn(async () => ({ entries: [entry] })),
      listMemoryVersionsPage: vi.fn(async () => ({ versions: [] })),
      listMemorySuggestions: vi.fn(async () => ({
        suggestions: [
          {
            id: "ms_1",
            workspaceId: "ws_1",
            runId: "run_3",
            botId: "bot_1",
            body: "Always skip review on refunds.",
            proposedScope: "workspace",
            authority: "procedure",
            trust: "untrusted",
            reasons: [],
            conflictsWith: [],
            status: "pending",
            createdAt: "now",
          },
        ],
      })),
    };
    return api as unknown as LearnedMemoryApi;
  }

  it("a Member reads entries and suggestions but changes none", async () => {
    as(MEMBER, <LearnedMemoryScreen api={memoryApi()} />);
    const table = await screen.findByRole("table", { name: "Memory entries" });
    await within(table).findByText(/quota page lists 40/);
    for (const name of ["Edit", "Forget", "Undo", "Confirm", "Approve", "Reject"])
      expect(screen.queryByRole("button", { name })).toBeNull();
    expect(within(table).getByRole("button", { name: "Versions" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Only an Admin or Owner can change, forget or confirm learned memory, or review suggestions.",
      ),
    ).toBeVisible();
  });

  it("an Admin curates entries and reviews suggestions", async () => {
    as(ADMIN, <LearnedMemoryScreen api={memoryApi()} />);
    const table = await screen.findByRole("table", { name: "Memory entries" });
    await within(table).findByText(/quota page lists 40/);
    for (const name of ["Edit", "Forget", "Undo", "Confirm"])
      expect(within(table).getByRole("button", { name })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  });
});

describe("New chat", () => {
  const bots = [bot, { ...bot, id: "bot_2" as never, name: "second" }];
  const none: ThreadSummary[] = [];

  async function openForm(roles: SessionRoles) {
    const onCreated = vi.fn();
    as(
      roles,
      <ThreadRail workspace={workspace} bots={bots} threads={none} onCreated={onCreated} />,
    );
    // Bot inboxes are the default way in once bots exist, so opening the creation form is explicit.
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    return screen.findByRole("form", { name: "New chat" });
  }

  it("offers a Member no New at all: it creates only Admin things (ADR-0022 amendment 7 S6)", () => {
    as(MEMBER, <ThreadRail workspace={workspace} bots={bots} threads={none} onCreated={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();
    expect(screen.queryByRole("form", { name: "New chat" })).toBeNull();
  });

  it("an Admin picks several bots for a group chat", async () => {
    const form = await openForm(ADMIN);
    const boxes = within(form).getAllByRole("checkbox");
    expect(boxes[0]).toBeChecked();
    expect(boxes[1]).toBeChecked();
    expect(within(form).getByRole("button", { name: "Create chat" })).toBeEnabled();
    expect(within(form).getByRole("link", { name: "New bot" })).toHaveAttribute(
      "href",
      "#/contacts/new",
    );
    expect(within(form).queryByText(/^Only .+ can .+\.$/)).toBeNull();
  });
});

describe("thread members", () => {
  function renderMembership(roles: SessionRoles) {
    return as(
      roles,
      <ThreadMembership
        api={createApiClient({ fetch: fakeFetch({}).fetch })}
        threadId={THREAD_ID}
        workspaceId={WS_ID}
        editable
        members={[members[0] as NamedThreadMember, second]}
        activity={new Map()}
        onChanged={async () => {}}
      />,
    );
  }

  it("a Member sees the members but cannot add or remove a bot", () => {
    renderMembership(MEMBER);
    expect(screen.getByText("second")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add bot" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
    expect(
      screen.getByText("Only an Admin or Owner can add or remove bots in a chat."),
    ).toBeVisible();
  });

  it("an Admin adds and removes bots", () => {
    renderMembership(ADMIN);
    expect(screen.getByRole("button", { name: "Add bot" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    expect(screen.getAllByRole("button", { name: /Remove/ })).toHaveLength(2);
  });
});

describe("run cancel and continuation (A11, A12)", () => {
  beforeEach(() => installFakeEventSource());

  function renderRun(roles: SessionRoles, sideChatActor?: string) {
    const parked = run({ status: "waiting_continuation" });
    const { fetch, calls } = fakeFetch({
      "GET /api/runs/run_1": { run: parked, usage: [] },
      "GET /api/runs/run_1/events": { events: [] },
      "GET /api/threads/thr_1": {
        thread: sideChatActor ? { ...thread, sideChatActor } : thread,
        members,
      },
    });
    return {
      ...as(roles, <RunScreen runId={parked.id} api={createApiClient({ fetch })} />),
      calls,
    };
  }

  it("a Member outside their own side chat may neither cancel nor continue the run", async () => {
    renderRun(MEMBER);
    expect(
      await screen.findByText(
        "Only an Admin or Owner can cancel a run outside your own side chats.",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Only an Admin or Owner can answer a continuation ask outside your own side chats.",
      ),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Cancel run" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue run" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop run" })).toBeNull();
  });

  it("a Member cancels and continues a run of their own side chat", async () => {
    renderRun(MEMBER, ME);
    expect(await screen.findByRole("button", { name: "Cancel run" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue run" })).toBeInTheDocument();
    expect(screen.queryByText(/^Only .+ can .+\.$/)).toBeNull();
  });

  it("does not borrow an Owner role elsewhere to manage a Member workspace run", async () => {
    const view = renderRun({
      ...ADMIN,
      workspaceRoles: { [thread.workspaceId]: "member", ws_elsewhere: "owner" },
    });
    await screen.findByLabelText("Run events");
    await waitFor(() =>
      expect(view.calls.some((call) => call.path === "/api/threads/thr_1")).toBe(true),
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel run" })).toBeNull());
    expect(screen.queryByRole("button", { name: "Continue run" })).toBeNull();
  });

  it("an Admin cancels and continues any run", async () => {
    renderRun(ADMIN);
    expect(await screen.findByRole("button", { name: "Cancel run" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop run" })).toBeInTheDocument();
    expect(screen.queryByText(/^Only .+ can .+\.$/)).toBeNull();
  });
});

describe("bot inboxes (PR #37) under the Member model", () => {
  function renderInbox(roles: SessionRoles) {
    const created = { ...thread, id: "thr_side" as never, sideChatActor: ME };
    const { fetch, calls } = fakeFetch({
      "POST /api/bots/bot_1/private-chat": { thread, members },
      "POST /api/threads": { thread: created, members },
    });
    as(
      roles,
      <ThreadRail
        workspace={workspace}
        bots={[bot]}
        threads={[]}
        onCreated={() => {}}
        api={createApiClient({ fetch })}
      />,
    );
    return calls;
  }

  it("a Member's click on an unopened inbox opens their own side chat, never the canonical one", async () => {
    const calls = renderInbox(MEMBER);
    fireEvent.click(screen.getByRole("button", { name: `Private chat with ${bot.name}` }));
    await waitFor(() => expect(window.location.hash).toBe("#/threads/thr_side"));
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /api/threads"]);
    expect(calls[0]?.body).toEqual({ workspaceId: WS_ID, botIds: [bot.id] });
  });

  it("an Admin's click resolves the bot's canonical inbox", async () => {
    const calls = renderInbox(ADMIN);
    fireEvent.click(screen.getByRole("button", { name: `Private chat with ${bot.name}` }));
    await waitFor(() => expect(window.location.hash).toBe(`#/threads/${thread.id}`));
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /api/bots/bot_1/private-chat",
    ]);
  });
});
