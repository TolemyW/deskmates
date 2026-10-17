// @vitest-environment jsdom
// T1 (in-process): the streamed reply preview in the chat (ADR-0037 decision 7). Frames grow one
// provisional bubble per live run; duplicates and reordered frames are ignored, so a reconnect
// needs no replay; the final message replaces the bubble and a cancelled or parked run drops it.

import type { ReplyPreviewFrame, RunId, ThreadId } from "@deskmates/contracts";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiClient } from "../../api/client.js";
import type { GatewayEvent } from "../../api/types.js";
import {
  FakeEventSource,
  THREAD_ID,
  fakeFetch,
  installFakeEventSource,
  members,
  message,
  run,
  thread,
  workspaceView,
} from "../../test-support/fixtures.js";
import { ChatPane } from "./chat-pane.js";
import { replyPreviewReducer } from "./reply-preview.js";

const active = run({ status: "running" });

function frame(seq: number, text: string, attempt = 1): GatewayEvent {
  const preview: ReplyPreviewFrame = {
    runId: active.id as RunId,
    threadId: THREAD_ID as ThreadId,
    botId: active.botId,
    attempt,
    seq,
    text,
  };
  return { type: "run_reply_preview", threadId: THREAD_ID as ThreadId, preview };
}

describe("replyPreviewReducer", () => {
  it("keeps the newest frame per run and drops it when the run is done", () => {
    let state = replyPreviewReducer({}, frame(2, "Hello"));
    state = replyPreviewReducer(state, frame(1, "He"));
    state = replyPreviewReducer(state, frame(2, "Hello"));
    expect(state[active.id]?.text).toBe("Hello");
    // A resumed attempt starts its own numbering.
    state = replyPreviewReducer(state, frame(1, "Again", 2));
    expect(state[active.id]?.text).toBe("Again");
    const parked = replyPreviewReducer(state, {
      type: "run_status",
      run: { ...active, status: "waiting_approval" },
    });
    expect(parked).toEqual({});
    const human = replyPreviewReducer(state, {
      type: "thread_message",
      threadId: THREAD_ID as ThreadId,
      message: { ...message(5, "human", "hi"), runId: active.id as RunId },
    });
    expect(human).toBe(state);
  });
});

describe("streamed reply in an open chat", () => {
  beforeEach(() => installFakeEventSource());
  afterEach(cleanup);

  function mount() {
    const { fetch } = fakeFetch({
      "GET /api/threads/thr_1": { thread, members },
      "GET /api/threads/thr_1/messages": { messages: [message(1, "human", "hi")] },
      "GET /api/runs?threadId=thr_1": { runs: [active] },
      "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
      "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [] },
      "GET /api/workspaces/ws_1": workspaceView(),
    });
    render(<ChatPane threadId={THREAD_ID} api={createApiClient({ fetch })} />);
  }

  const emit = (event: GatewayEvent) =>
    act(() => FakeEventSource.forUrl(`/api/events?threadId=${THREAD_ID}`).emit(event));

  it("grows one bubble and replaces it with the final message", async () => {
    mount();
    await screen.findByTestId("typing");
    emit(frame(1, "Hel"));
    emit(frame(3, "Hello wor"));
    emit(frame(2, "Hello"));
    emit(frame(3, "Hello wor"));
    const bubble = await screen.findByTestId("reply-preview");
    expect(bubble.textContent).toContain("Hello wor");
    expect(screen.getAllByTestId("reply-preview")).toHaveLength(1);

    emit({
      type: "thread_message",
      threadId: THREAD_ID as ThreadId,
      message: { ...message(2, "bot", "Hello world"), runId: active.id as RunId },
    });
    await waitFor(() => expect(screen.queryByTestId("reply-preview")).toBeNull());
    expect(screen.getByText("Hello world")).toBeTruthy();
  });

  it("drops the bubble when the run is cancelled", async () => {
    mount();
    await screen.findByTestId("typing");
    emit(frame(1, "Partial"));
    await screen.findByTestId("reply-preview");
    emit({
      type: "run_status",
      threadId: THREAD_ID as ThreadId,
      run: { ...active, status: "cancelled" },
    });
    await waitFor(() => expect(screen.queryByTestId("reply-preview")).toBeNull());
    expect(screen.queryByText("Partial")).toBeNull();
  });
});
