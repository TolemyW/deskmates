// @vitest-environment jsdom
// T0 web for #113 slice CH (plan row 24): the Chats rail reads one page of the current
// workspace's conversations, offers older ones on request, keeps them through a refresh of the
// first page, and still lists a chat opened from an old link. Paging posts nothing and starts no
// run.

import "@testing-library/jest-dom/vitest";
import type { BotDefinition, BotId, ThreadId, ThreadSummary } from "@deskmates/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiClient } from "../../api/client.js";
import {
  FakeEventSource,
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
import { ThreadScreen } from "./thread.js";

const peer: BotDefinition = { ...bot, id: "bot_peer" as BotId, name: "peer", workspaceId: WS_ID };
const group = (id: string, title: string, at: string): ThreadSummary => ({
  ...thread,
  id: id as ThreadId,
  title,
  updatedAt: at,
  memberIds: [bot.id, peer.id],
});
const newest = group("thr_new", "Newest group", "2026-10-14T10:00:00.000Z");
const oldest = group("thr_old", "Oldest group", "2026-01-01T10:00:00.000Z");

const rail = () => screen.getByRole("complementary");

beforeEach(() => {
  installFakeEventSource();
  window.location.hash = "";
});
afterEach(() => {
  cleanup();
  window.location.hash = "";
});

describe("Chats rail pages (#113 CH)", () => {
  it("loads older conversations on request and keeps them through a refresh", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /api/workspaces": { workspaces: [workspace] },
      "GET /api/bots": { bots: [bot, peer] },
      "GET /api/threads?workspaceId=ws_1&limit=50": { threads: [newest], nextCursor: "c2" },
      "GET /api/threads?workspaceId=ws_1&limit=50&cursor=c2": { threads: [oldest] },
    });
    render(<ThreadScreen api={createApiClient({ fetch })} />);
    await screen.findByText("Newest group");
    expect(within(rail()).queryByText("Oldest group")).toBeNull();
    fireEvent.click(within(rail()).getByRole("button", { name: "Show older chats" }));
    await within(rail()).findByText("Oldest group");
    expect(within(rail()).queryByRole("button", { name: "Show older chats" })).toBeNull();
    // A list refresh reads page one again; the older page stays.
    const before = calls.length;
    act(() =>
      FakeEventSource.forUrl("/api/events").emit({ type: "thread_activity", threadId: newest.id }),
    );
    await waitFor(() => expect(calls.length).toBeGreaterThan(before));
    await waitFor(() => expect(within(rail()).getByText("Oldest group")).toBeInTheDocument());
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("finds a conversation beyond the loaded pages through the server search", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /api/workspaces": { workspaces: [workspace] },
      "GET /api/bots": { bots: [bot, peer] },
      "GET /api/threads?workspaceId=ws_1&limit=50": { threads: [newest], nextCursor: "c2" },
      "GET /api/threads?workspaceId=ws_1&limit=50&q=Oldest": { threads: [oldest] },
    });
    render(<ThreadScreen api={createApiClient({ fetch })} />);
    await screen.findByText("Newest group");
    fireEvent.change(within(rail()).getByRole("searchbox", { name: "Search chats" }), {
      target: { value: "Oldest" },
    });
    await within(rail()).findByText("Oldest group");
    expect(within(rail()).queryByText("Newest group")).toBeNull();
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("lists a chat opened from a link although it is beyond the first page", async () => {
    const { fetch } = fakeFetch({
      "GET /api/workspaces": { workspaces: [workspace] },
      "GET /api/bots": { bots: [bot, peer] },
      "GET /api/threads?workspaceId=ws_1&limit=50": { threads: [newest], nextCursor: "c2" },
      "GET /api/threads/thr_old": { thread: oldest, members },
      "GET /api/threads/thr_old/messages": { messages: [message(1, "human", "an old ask")] },
      "GET /api/runs?threadId=thr_old": { runs: [] },
      "GET /api/approvals?status=pending&threadId=thr_old": { approvals: [] },
      "GET /api/approvals?status=decided&threadId=thr_old": { approvals: [] },
      "GET /api/workspaces/ws_1": workspaceView(),
    });
    render(<ThreadScreen api={createApiClient({ fetch })} threadId={oldest.id} />);
    await screen.findByText("an old ask");
    await within(rail()).findByText("Oldest group");
  });
});
