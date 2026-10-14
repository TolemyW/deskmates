// @vitest-environment jsdom
// T0 web for ADR-0024 amendment 2, decision 11 (issue #122): the composer offers Retry welcome only
// when the welcome's greeting never reached this chat. A silent welcome that greeted through
// `thread_post` is delivered; the answer must agree on load, after either live arrival order and
// after reload, and a double click submits one retry.

import "@testing-library/jest-dom/vitest";
import type { RunId } from "@deskmates/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiClient } from "../../api/client.js";
import type { RunView } from "../../api/types.js";
import {
  BOT_ID,
  FakeEventSource,
  type RouteTable,
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

const WELCOME_ID = "run_welcome" as RunId;
const FAILED_TEXT = "The bot could not send its welcome message.";

function welcome(extra: Partial<RunView> = {}): RunView {
  return run({ id: WELCOME_ID, triggerKind: "welcome", triggerRef: "welcome_1", ...extra });
}

const greeting = message(1, "bot", "Hello, I am ops.", { runId: WELCOME_ID });

function routes(runs: RunView[], messages = [greeting], extra: RouteTable = {}): RouteTable {
  return {
    "GET /api/threads/thr_1": { thread, members },
    "GET /api/threads/thr_1/messages": { messages },
    "GET /api/runs?threadId=thr_1": { runs },
    "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
    "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [] },
    "GET /api/workspaces/ws_1": workspaceView(),
    ...extra,
  };
}

function renderPane(table: RouteTable) {
  const { fetch, calls } = fakeFetch(table);
  const view = render(<ChatPane threadId={THREAD_ID} api={createApiClient({ fetch })} />);
  return { calls, view, api: createApiClient({ fetch }) };
}

const stream = () => FakeEventSource.forUrl(`/api/events?threadId=${THREAD_ID}`);

describe("welcome delivery in the chat pane", () => {
  beforeEach(() => installFakeEventSource());
  afterEach(() => cleanup());

  it("shows no failure for a silent welcome that greeted through thread_post, also on reload", async () => {
    const table = routes([welcome({ status: "silent", welcomeDelivery: "delivered" })]);
    const first = renderPane(table);
    await screen.findByText("Hello, I am ops.");
    expect(screen.queryByText(FAILED_TEXT)).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry welcome" })).toBeNull();
    first.view.unmount();

    renderPane(table);
    await screen.findByText("Hello, I am ops.");
    expect(screen.queryByText(FAILED_TEXT)).toBeNull();
  });

  it("trusts the Gateway flag when the greeting is outside the loaded transcript", async () => {
    renderPane(
      routes(
        [welcome({ status: "silent", welcomeDelivery: "delivered" })],
        [message(40, "human", "a later question")],
      ),
    );
    await screen.findByText("a later question");
    expect(screen.queryByText(FAILED_TEXT)).toBeNull();
  });

  it.each([
    ["message before run status", ["message", "run"]],
    ["run status before message", ["run", "message"]],
  ])("settles to delivered when live frames arrive %s", async (_label, order) => {
    renderPane(routes([welcome({ status: "running" })], []));
    await waitFor(() => expect(stream()).toBeDefined());
    await screen.findByText("ops · ops running");
    for (const frame of order) {
      act(() => {
        if (frame === "message")
          stream().emit({ type: "thread_message", threadId: THREAD_ID, message: greeting });
        // A live status frame carries no delivery flag; the transcript decides.
        else
          stream().emit({
            type: "run_status",
            threadId: THREAD_ID,
            run: welcome({ status: "silent", finishedAt: "2026-09-21T10:01:00.000Z" }),
          });
      });
    }
    await screen.findByText("Hello, I am ops.");
    expect(screen.queryByText(FAILED_TEXT)).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry welcome" })).toBeNull();
  });

  it("keeps an empty silent welcome retryable and submits a double click once", async () => {
    let resolveRetry: (value: unknown) => void = () => {};
    const { calls } = renderPane(
      routes([welcome({ status: "silent", welcomeDelivery: "undelivered" })], [], {
        [`POST /api/bots/${BOT_ID}/welcome`]: () =>
          new Promise((resolve) => {
            resolveRetry = resolve;
          }),
      }),
    );
    await screen.findByText(FAILED_TEXT);
    const retry = screen.getByRole("button", { name: "Retry welcome" });
    fireEvent.click(retry);
    fireEvent.click(retry);
    await screen.findByRole("button", { name: "Retrying…" });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    await act(async () => {
      resolveRetry({
        run: welcome({
          id: "run_welcome_2" as RunId,
          status: "queued",
          createdAt: "2026-09-21T11:00:00.000Z",
        }),
        thread,
      });
    });
    await waitFor(() => expect(screen.queryByText(FAILED_TEXT)).toBeNull());
  });

  it("reports a failed welcome that already posted without offering a retry", async () => {
    renderPane(routes([welcome({ status: "failed", welcomeDelivery: "partial" })]));
    await screen.findByText("Hello, I am ops.");
    expect(await screen.findByRole("status")).toHaveTextContent(
      /The welcome run ended .* after posting a message\./,
    );
    expect(screen.queryByText(FAILED_TEXT)).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry welcome" })).toBeNull();
  });

  it("still offers a retry for a failure before any greeting", async () => {
    renderPane(routes([welcome({ status: "failed", welcomeDelivery: "undelivered" })], []));
    expect(await screen.findByText(FAILED_TEXT)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry welcome" })).toBeEnabled();
  });
});
