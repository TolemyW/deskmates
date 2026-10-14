// @vitest-environment jsdom
// T0 web for #113 slice CH: the transcript opens on its newest window and loads older messages on
// request; a reconnect reads the missed tail in bounded slices; the private chat's incoming
// handoffs load older pages on request. Opening and paging start no run.

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiClient } from "../../api/client.js";
import {
  FakeEventSource,
  type RouteTable,
  THREAD_ID,
  fakeFetch,
  installFakeEventSource,
  members,
  message,
  thread,
  workspaceView,
} from "../../test-support/fixtures.js";
import { ChatPane } from "./chat-pane.js";

function routes(extra: RouteTable = {}): RouteTable {
  return {
    "GET /api/threads/thr_1": { thread, members },
    "GET /api/threads/thr_1/messages": {
      messages: [message(51, "human", "newest window starts here")],
      hasOlder: true,
    },
    "GET /api/threads/thr_1/messages?beforeSeq=51": {
      messages: [message(1, "human", "the very first message")],
      hasOlder: false,
    },
    "GET /api/runs?threadId=thr_1": { runs: [] },
    "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
    "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [] },
    "GET /api/workspaces/ws_1": workspaceView(),
    ...extra,
  };
}

describe("bounded chat transcript (#113 CH)", () => {
  beforeEach(() => installFakeEventSource());
  afterEach(() => cleanup());

  it("loads older messages above the newest window and starts no run", async () => {
    const { fetch, calls } = fakeFetch(routes());
    render(<ChatPane threadId={THREAD_ID} api={createApiClient({ fetch })} />);
    await screen.findByText("newest window starts here");
    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
    await screen.findByText("the very first message");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Load older messages" })).toBeNull(),
    );
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("recovers a stream gap with bounded tails until none is left", async () => {
    const { fetch, calls } = fakeFetch(
      routes({
        "GET /api/threads/thr_1/messages?afterSeq=51": {
          messages: [message(52, "human", "missed one")],
          hasMore: true,
        },
        "GET /api/threads/thr_1/messages?afterSeq=52": {
          messages: [message(53, "human", "missed two")],
          hasMore: false,
        },
      }),
    );
    render(<ChatPane threadId={THREAD_ID} api={createApiClient({ fetch })} />);
    await screen.findByText("newest window starts here");
    const stream = FakeEventSource.forUrl(`/api/events?threadId=${THREAD_ID}`);
    act(() => {
      stream.drop();
      stream.open();
    });
    await screen.findByText("missed two");
    expect(screen.getByText("missed one")).toBeInTheDocument();
    expect(calls.map((c) => c.path)).toContain("/api/threads/thr_1/messages?afterSeq=52");
  });

  it("loads older incoming handoffs on request", async () => {
    const handoff = (seq: number, excerpt: string) => ({
      seq,
      callerName: "beta",
      excerpt,
      sourceThreadId: "thr_src",
      sourceMessageId: `msg_src_${seq}`,
      handoffThreadId: "thr_bus",
      runId: `run_${seq}`,
      status: "succeeded",
      createdAt: "2026-10-14T10:00:00.000Z",
      unread: false,
    });
    const { fetch } = fakeFetch(
      routes({
        "GET /api/threads/thr_1/activity": {
          handoffs: [handoff(30, "newest request")],
          nextCursor: "c2",
        },
        "GET /api/threads/thr_1/activity?cursor=c2": { handoffs: [handoff(3, "oldest request")] },
      }),
    );
    render(<ChatPane threadId={THREAD_ID} api={createApiClient({ fetch })} />);
    await screen.findByText("newest request");
    fireEvent.click(screen.getByRole("button", { name: "Load older collaboration requests" }));
    await screen.findByText("oldest request");
    expect(screen.queryByRole("button", { name: "Load older collaboration requests" })).toBeNull();
  });
});
