// @vitest-environment jsdom
// T1 (in-process), issue #29 / ADR-0024 decision 6: the Chats rail shows one private entry per
// bot of the current workspace, beside groups and Bots talking. Only an explicit click resolves
// an unopened inbox through `POST /api/bots/:id/private-chat`; rendering, polling and search
// never do, and opening sends no message and starts no run. The canonical mark comes from the
// Gateway (`privateChatBotId`), never from a member count.

import "@testing-library/jest-dom/vitest";
import type {
  BotDefinition,
  BotId,
  Thread,
  ThreadId,
  ThreadSummary,
  Workspace,
  WorkspaceId,
} from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ApiClient, createApiClient } from "../../api/client.js";
import type { ThreadDetailView } from "../../api/types.js";
import {
  FakeEventSource,
  type RecordedCall,
  WS_ID,
  bot,
  fakeFetch,
  installFakeEventSource,
  thread,
  workspace,
} from "../../test-support/fixtures.js";
import { ThreadRail } from "./thread-rail.js";
import { ThreadScreen } from "./thread.js";

const T = "2026-09-21T10:00:00.000Z";

function makeBot(name: string, role: string, workspaceId: WorkspaceId = WS_ID): BotDefinition {
  return { ...bot, id: `bot_${name}` as BotId, name, role, workspaceId };
}

function summary(id: string, extra: Partial<ThreadSummary>): ThreadSummary {
  return { ...thread, id: id as ThreadId, title: "", memberIds: [], ...extra };
}

const lead = makeBot("lead", "Coordinates the research");
const analyst = makeBot("analyst", "Reads filings");
const scout = makeBot("scout", "Browses public sites");
const writer = makeBot("writer", "Drafts the brief");
const four = [lead, analyst, scout, writer];
const group = summary("thr_group", {
  title: "Market research",
  memberIds: four.map((b) => b.id),
  lastMessage: {
    seq: 3,
    authorKind: "bot",
    authorId: lead.id,
    excerpt: "Draft is in /work/brief.md",
    ts: T,
  },
});

/** POSTs other than the explicit resolver: messages, runs, threads, members. */
function sideEffects(calls: readonly RecordedCall[]): RecordedCall[] {
  return calls.filter((c) => c.method !== "GET" && !c.path.endsWith("/private-chat"));
}

function resolves(calls: readonly RecordedCall[]): string[] {
  return calls.filter((c) => c.path.endsWith("/private-chat")).map((c) => `${c.method} ${c.path}`);
}

function detail(t: Thread, botId: BotId): ThreadDetailView {
  return {
    thread: t,
    members: [{ threadId: t.id, botId, lastSeenSeq: 0, joinedAt: T, name: botId }],
  };
}

const rail = () => screen.getByRole("complementary");

beforeEach(() => {
  installFakeEventSource();
  window.location.hash = "";
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.location.hash = "";
});

describe("Chats rail bot inboxes", () => {
  it("lists four private entries plus the group without resolving or posting anything", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /api/workspaces": { workspaces: [workspace] },
      "GET /api/bots": { bots: four },
      "GET /api/threads?workspaceId=ws_1&limit=50": { threads: [group] },
    });
    render(<ThreadScreen api={createApiClient({ fetch })} />);
    await screen.findByText("Market research");
    for (const b of four) {
      const entry = within(rail()).getByRole("button", { name: `Private chat with ${b.name}` });
      expect(entry).toHaveTextContent(b.role);
      expect(entry).not.toHaveTextContent("No messages yet");
    }
    expect(within(rail()).queryByText("Private chats")).not.toBeInTheDocument();
    expect(within(rail()).queryByText("Groups")).not.toBeInTheDocument();
    expect(within(rail()).getByText("Draft is in /work/brief.md")).toBeInTheDocument();

    // Polling (an activity event reloads the list) and searching do not resolve either.
    FakeEventSource.forUrl("/api/events").emit({ type: "thread_activity", threadId: group.id });
    fireEvent.change(within(rail()).getByRole("searchbox", { name: "Search chats" }), {
      target: { value: "filings" },
    });
    expect(
      within(rail()).getByRole("button", { name: "Private chat with analyst" }),
    ).toBeInTheDocument();
    expect(within(rail()).queryByText("Market research")).toBeNull();
    await waitFor(() =>
      expect(
        calls.filter((c) => c.path === "/api/threads?workspaceId=ws_1&limit=50").length,
      ).toBeGreaterThan(1),
    );
    expect(resolves(calls)).toEqual([]);
    expect(sideEffects(calls)).toEqual([]);
    // Bots exist, so the create dialog does not force itself open.
    expect(screen.queryByLabelText("New thread")).toBeNull();
  });

  it("opens an unopened inbox through the resolver once, with no message or run", async () => {
    const created = { ...thread, id: "thr_new" as ThreadId, title: "" };
    let answer: ((value: unknown) => void) | undefined;
    // Once resolved, the Gateway lists the chat with its canonical mark.
    let listed: ThreadSummary[] = [group];
    const { fetch, calls } = fakeFetch({
      "GET /api/workspaces": { workspaces: [workspace] },
      "GET /api/bots": { bots: four },
      "GET /api/threads?workspaceId=ws_1&limit=50": () => ({ threads: listed }),
      [`POST /api/bots/${analyst.id}/private-chat`]: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    render(<ThreadScreen api={createApiClient({ fetch })} />);
    const entry = await screen.findByRole("button", {
      name: "Private chat with analyst",
    });
    fireEvent.click(entry);
    fireEvent.click(entry);
    await waitFor(() => expect(answer).toBeDefined());
    expect(entry).toHaveAttribute("aria-busy", "true");
    expect(entry).toHaveTextContent("Opening…");
    fireEvent.click(entry);
    listed = [
      { ...created, memberIds: [analyst.id], privateChatBotId: analyst.id, updatedAt: T },
      group,
    ];
    answer?.(detail(created, analyst.id));
    await waitFor(() => expect(window.location.hash).toBe("#/threads/thr_new"));
    expect(resolves(calls)).toEqual([`POST /api/bots/${analyst.id}/private-chat`]);
    expect(sideEffects(calls)).toEqual([]);
    // The resolved inbox replaces the unopened entry: one row for the bot, a link to the chat.
    await waitFor(() =>
      expect(within(rail()).getByRole("link", { name: /analyst/ })).toHaveAttribute(
        "href",
        "#/threads/thr_new",
      ),
    );
    expect(within(rail()).queryByRole("button", { name: "Private chat with analyst" })).toBeNull();
  });

  it("reuses the listed canonical chat and nests newer task chats and older history as other conversations", async () => {
    const canonical = summary("thr_canon", {
      memberIds: [analyst.id],
      privateChatBotId: analyst.id,
      unreadHandoffs: 2,
      lastMessage: { seq: 4, authorKind: "bot", authorId: analyst.id, excerpt: "Q3 filed", ts: T },
    });
    // Issue #122: a task chat created after the canonical chat is listed first (recency order).
    const task = summary("thr_task", {
      title: "Quarterly task",
      memberIds: [analyst.id],
      lastMessage: { seq: 2, authorKind: "bot", authorId: analyst.id, excerpt: "task done", ts: T },
    });
    const older = summary("thr_old", {
      title: "Old filing thread",
      memberIds: [analyst.id],
      lastMessage: { seq: 9, authorKind: "human", authorId: "op", excerpt: "keep me", ts: T },
    });
    const { fetch, calls } = fakeFetch({
      "GET /api/workspaces": { workspaces: [workspace] },
      "GET /api/bots": { bots: four },
      "GET /api/threads?workspaceId=ws_1&limit=50": { threads: [task, canonical, older, group] },
    });
    render(<ThreadScreen api={createApiClient({ fetch })} />);
    await screen.findByText("Q3 filed");
    const links = within(rail()).getAllByRole("link");
    expect(links.filter((a) => a.getAttribute("href") === "#/threads/thr_canon")).toHaveLength(1);
    expect(within(rail()).queryByRole("button", { name: "Private chat with analyst" })).toBeNull();
    expect(within(rail()).getByLabelText("2 unread collaboration requests")).toBeInTheDocument();
    // Both one-member chats stay readable under the bot, with no catch-all Other section and no
    // claim that the newer task chat is earlier history (ADR-0024 amendment 2, decision 12).
    expect(within(rail()).queryByText("Other chats")).not.toBeInTheDocument();
    expect(within(rail()).queryByText(/Earlier conversations/)).not.toBeInTheDocument();
    expect(within(rail()).getByText("Other conversations (2)")).toBeInTheDocument();
    const nested = within(rail())
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"))
      .filter((href) => href === "#/threads/thr_task" || href === "#/threads/thr_old");
    expect(nested).toEqual(["#/threads/thr_task", "#/threads/thr_old"]);
    expect(within(rail()).getByText("Old filing thread")).toBeInTheDocument();
    expect(within(rail()).getByText("keep me")).toBeInTheDocument();
    // Three other bots remain unopened; nothing was resolved and no run was started.
    expect(within(rail()).getAllByRole("button", { name: /^Private chat with / })).toHaveLength(3);
    expect(resolves(calls)).toEqual([]);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("shows workspace pins first and exposes the shared pin action on the row", async () => {
    const canonical = summary("thr_canon", {
      memberIds: [analyst.id],
      privateChatBotId: analyst.id,
      pinPosition: 1,
    });
    const { fetch, calls } = fakeFetch({
      [`DELETE /api/threads/${canonical.id}/pin`]: { deleted: true },
    });
    const onPinsChanged = vi.fn();
    render(
      <ThreadRail
        workspace={workspace}
        bots={[analyst]}
        threads={[canonical]}
        onCreated={() => {}}
        onPinsChanged={onPinsChanged}
        api={createApiClient({ fetch })}
      />,
    );
    expect(screen.getByText("Pinned")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "More actions for analyst" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Unpin" }));
    await waitFor(() => expect(onPinsChanged).toHaveBeenCalledOnce());
    expect(calls).toContainEqual({
      method: "DELETE",
      path: `/api/threads/${canonical.id}/pin`,
      body: undefined,
    });
  });

  it("keeps a promoted canonical chat as a group and asks the resolver for a fresh inbox", async () => {
    // The Gateway cleared the binding when the human added a member (ADR-0024 decision 6).
    const promoted = summary("thr_was_private", {
      memberIds: [analyst.id, scout.id],
      lastMessage: { seq: 2, authorKind: "human", authorId: "op", excerpt: "both of you", ts: T },
    });
    const fresh = { ...thread, id: "thr_fresh" as ThreadId, title: "" };
    const { fetch, calls } = fakeFetch({
      "GET /api/workspaces": { workspaces: [workspace] },
      "GET /api/bots": { bots: four },
      "GET /api/threads?workspaceId=ws_1&limit=50": { threads: [promoted] },
      [`POST /api/bots/${analyst.id}/private-chat`]: detail(fresh, analyst.id),
    });
    render(<ThreadScreen api={createApiClient({ fetch })} />);
    await screen.findByText("both of you");
    expect(within(rail()).queryByText("Groups")).not.toBeInTheDocument();
    fireEvent.click(within(rail()).getByRole("button", { name: "Private chat with analyst" }));
    await waitFor(() => expect(window.location.hash).toBe("#/threads/thr_fresh"));
    expect(within(rail()).getByText("both of you")).toBeInTheDocument();
    expect(resolves(calls)).toHaveLength(1);
  });

  it("shows a failure inline with a retry and does not guess a destination", async () => {
    let fail = true;
    const fresh = { ...thread, id: "thr_fresh" as ThreadId, title: "" };
    const { fetch, calls } = fakeFetch({
      "GET /api/workspaces": { workspaces: [workspace] },
      "GET /api/bots": { bots: four },
      "GET /api/threads?workspaceId=ws_1&limit=50": { threads: [] },
      [`POST /api/bots/${scout.id}/private-chat`]: () =>
        fail ? new Error("bot is archived") : detail(fresh, scout.id),
    });
    render(<ThreadScreen api={createApiClient({ fetch })} />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Private chat with scout",
      }),
    );
    const alert = await within(rail()).findByRole("alert");
    expect(alert).toHaveTextContent("bot is archived");
    expect(window.location.hash).toBe("");
    fail = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(window.location.hash).toBe("#/threads/thr_fresh"));
    expect(within(rail()).queryByRole("alert")).toBeNull();
    expect(resolves(calls)).toHaveLength(2);
    expect(sideEffects(calls)).toEqual([]);
  });
});

describe("ThreadRail inbox races", () => {
  const other: Workspace = { ...workspace, id: "ws_2" as WorkspaceId, name: "other" };
  const elsewhere = makeBot("elsewhere", "Other team", other.id);

  function deferredApi() {
    let answer: ((value: ThreadDetailView) => void) | undefined;
    const resolvePrivateChat = vi.fn(
      () =>
        new Promise<ThreadDetailView>((resolve) => {
          answer = resolve;
        }),
    );
    const api = { resolvePrivateChat } as unknown as ApiClient;
    return { api, resolvePrivateChat, answer: (v: ThreadDetailView) => answer?.(v) };
  }

  it("drops a resolution that finishes after the workspace changed", async () => {
    const { api, resolvePrivateChat, answer } = deferredApi();
    const onPrivateChat = vi.fn();
    const view = render(
      <ThreadRail
        workspace={workspace}
        bots={four}
        threads={[]}
        onCreated={() => {}}
        onPrivateChat={onPrivateChat}
        api={api}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Private chat with lead" }));
    expect(resolvePrivateChat).toHaveBeenCalledTimes(1);
    view.rerender(
      <ThreadRail
        workspace={other}
        bots={[elsewhere]}
        threads={[]}
        onCreated={() => {}}
        onPrivateChat={onPrivateChat}
        api={api}
      />,
    );
    expect(screen.queryByRole("button", { name: "Private chat with lead" })).toBeNull();
    answer(detail({ ...thread, id: "thr_late" as ThreadId }, lead.id));
    await new Promise((r) => setTimeout(r, 0));
    expect(onPrivateChat).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("");
    expect(screen.getByRole("button", { name: "Private chat with elsewhere" })).not.toHaveAttribute(
      "aria-busy",
      "true",
    );
  });

  it("does not navigate after unmounting, or when the operator moved on meanwhile", async () => {
    const first = deferredApi();
    const onPrivateChat = vi.fn();
    const view = render(
      <ThreadRail
        workspace={workspace}
        bots={four}
        threads={[]}
        onCreated={() => {}}
        onPrivateChat={onPrivateChat}
        api={first.api}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Private chat with lead" }));
    view.unmount();
    first.answer(detail({ ...thread, id: "thr_late" as ThreadId }, lead.id));
    await new Promise((r) => setTimeout(r, 0));
    expect(onPrivateChat).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("");

    const second = deferredApi();
    render(
      <ThreadRail
        workspace={workspace}
        bots={four}
        threads={[]}
        onCreated={() => {}}
        onPrivateChat={onPrivateChat}
        api={second.api}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Private chat with writer" }));
    window.location.hash = "#/threads/thr_elsewhere";
    second.answer(detail({ ...thread, id: "thr_writer" as ThreadId }, writer.id));
    await waitFor(() => expect(onPrivateChat).toHaveBeenCalledTimes(1));
    expect(onPrivateChat.mock.calls[0]?.[0]).toMatchObject({
      botId: writer.id,
      thread: { id: "thr_writer" },
    });
    expect(window.location.hash).toBe("#/threads/thr_elsewhere");
  });

  it("refuses a destination in another workspace", async () => {
    const { api, answer } = deferredApi();
    const onPrivateChat = vi.fn();
    render(
      <ThreadRail
        workspace={workspace}
        bots={four}
        threads={[]}
        onCreated={() => {}}
        onPrivateChat={onPrivateChat}
        api={api}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Private chat with lead" }));
    answer(detail({ ...thread, id: "thr_x" as ThreadId, workspaceId: other.id }, lead.id));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(onPrivateChat).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("");
  });
});

describe("Chats rail search and empty states", () => {
  const noop = () => {};

  it("keeps search usable with bots and zero threads and says when nothing matches", () => {
    render(<ThreadRail workspace={workspace} bots={four} threads={[]} onCreated={noop} />);
    expect(screen.queryByLabelText("New thread")).toBeNull();
    expect(screen.queryByText("No chats yet.")).toBeNull();
    const search = screen.getByRole("searchbox", { name: "Search chats" });
    fireEvent.change(search, { target: { value: "drafts" } });
    expect(screen.getAllByRole("button", { name: /^Private chat with / })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Private chat with writer" })).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.getByText("No chat matches “zzz”.")).toBeInTheDocument();
    expect(screen.queryByText("No chats yet.")).toBeNull();
  });

  it("matches conversation titles and previews as well as bots", () => {
    render(<ThreadRail workspace={workspace} bots={four} threads={[group]} onCreated={noop} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search chats" }), {
      target: { value: "brief.md" },
    });
    expect(screen.getByText("Market research")).toBeInTheDocument();
    expect(screen.queryAllByRole("button", { name: /^Private chat with / })).toHaveLength(0);
  });

  it("keeps first-chat onboarding for a workspace with no bots", async () => {
    render(<ThreadRail workspace={workspace} bots={[]} threads={[]} onCreated={noop} />);
    expect(screen.getByText("No chats yet.")).toBeInTheDocument();
    expect(await screen.findByLabelText("New thread")).toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("truncates long names and roles without dropping the entry", () => {
    const long = makeBot(
      "an_extremely_long_bot_handle_that_keeps_going",
      "A very long role description that explains far more than one line can hold in the rail",
    );
    render(<ThreadRail workspace={workspace} bots={[long]} threads={[]} onCreated={noop} />);
    const entry = screen.getByRole("button", { name: `Private chat with ${long.name}` });
    expect(entry.querySelector(".thread-title > span:first-child")).toHaveTextContent(long.name);
    expect(entry.querySelector(".thread-preview")).toHaveTextContent(long.role);
    // An unopened inbox shows no fabricated time or unread count.
    expect(entry.querySelector(".thread-time")).toBeNull();
    expect(entry.querySelector(".handoff-unread")).toBeNull();
  });
});

it("interleaves private and group chats by recency and preserves shared pin order across both", () => {
  const inbox = summary("thr_lead", {
    privateChatBotId: lead.id,
    memberIds: [lead.id],
    updatedAt: "2026-10-11T08:00:00Z",
  });
  const newerGroup = { ...group, updatedAt: "2026-10-11T09:00:00Z" };
  const { rerender } = render(
    <ThreadRail
      workspace={workspace}
      bots={[lead, analyst]}
      threads={[inbox, newerGroup]}
      onCreated={() => {}}
    />,
  );
  const links = () =>
    within(rail())
      .getAllByRole("link")
      .filter((link) => link.getAttribute("href")?.startsWith("#/threads/"));
  expect(links().map((link) => link.getAttribute("href"))).toEqual([
    "#/threads/thr_group",
    "#/threads/thr_lead",
  ]);
  rerender(
    <ThreadRail
      workspace={workspace}
      bots={[lead, analyst]}
      threads={[
        { ...inbox, pinPosition: 2 },
        { ...newerGroup, pinPosition: 1 },
      ]}
      onCreated={() => {}}
    />,
  );
  expect(links().map((link) => link.getAttribute("href"))).toEqual([
    "#/threads/thr_group",
    "#/threads/thr_lead",
  ]);
});
