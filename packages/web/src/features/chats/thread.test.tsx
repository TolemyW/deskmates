// @vitest-environment jsdom
// T1 (in-process): the thread screen lists threads, renders the transcript with author labels,
// posts `{body}` to the documented route, shows the typing indicator while a run is active,
// appends bot replies from SSE, recovers what a stream gap swallowed, leaves the Enter that
// commits an IME composition alone, and offers the first-run form on an empty database.

import {
  type BotDefinition,
  type BotId,
  type RunId,
  THREAD_LINK_ATTACHMENT_MIME,
  type Thread,
  type ThreadId,
  type Workspace,
  type WorkspaceId,
} from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import { WorkspaceScopeProvider } from "../../state/workspace-scope.js";
import {
  BOT_ID,
  FakeEventSource,
  RUN_ID,
  THREAD_ID,
  WS_ID,
  bot,
  fakeFetch,
  installFakeEventSource,
  members,
  message,
  run,
  thread,
  workspace,
  workspaceView,
} from "../../test-support/fixtures.js";
import { ThreadScreen } from "./thread.js";

const transcript = [
  message(1, "human", "check the console"),
  message(2, "system", "ops joined"),
  message(3, "bot", "on it", { runId: RUN_ID }),
];

describe("ThreadScreen", () => {
  beforeEach(() => {
    localStorage.removeItem("deskmates.showChatInfo");
    installFakeEventSource();
    window.location.hash = "";
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the transcript with author labels and links bot messages to their run", async () => {
    const { fetch } = fakeFetch({
      "GET /api/bots/bot_1/screen": { state: "stopped", humanHeld: false },
      "GET /api/bots/bot_2/screen": { state: "stopped", humanHeld: false },
      "GET /api/workspaces": { workspaces: [workspace] },
      "GET /api/bots": { bots: [bot] },
      "GET /api/threads?workspaceId=ws_1&limit=50": { threads: [thread] },
      "GET /api/threads/thr_1": { thread, members },
      "GET /api/workspaces/ws_1": workspaceView(),
      "GET /api/threads/thr_1/messages": { messages: transcript },
      "GET /api/runs?threadId=thr_1": { runs: [run({ status: "succeeded" })] },
      "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
      "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [] },
    });
    render(<ThreadScreen threadId={THREAD_ID} api={createApiClient({ fetch })} />);

    const list = await screen.findByLabelText("Transcript");
    await within(list).findByText("check the console");
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((r) => r.querySelector(".author")?.textContent)).toEqual([
      "human",
      "system",
      "ops",
    ]);
    const link = within(rows[2] as HTMLElement).getByRole("link", { name: "run" });
    expect(link.getAttribute("href")).toBe(`#/runs/${RUN_ID}`);
    expect(screen.queryByTestId("typing")).toBeNull();
    // The rail lists the thread and marks it selected.
    const rail = screen.getByRole("complementary");
    expect(within(rail).getByText("Morning check").closest("li")?.className).toBe("selected");
    expect(FakeEventSource.forUrl("/api/events?threadId=thr_1").url).toBe(
      `/api/events?threadId=${THREAD_ID}`,
    );
  });

  it("shows the thread's deadline in the header, marked once it has passed", async () => {
    const passed = { ...thread, deadline: "2020-01-01T00:00:00.000Z" };
    const { fetch } = fakeFetch({
      "GET /api/bots/bot_1/screen": { state: "stopped", humanHeld: false },
      "GET /api/bots/bot_2/screen": { state: "stopped", humanHeld: false },
      "GET /api/workspaces": { workspaces: [workspace] },
      "GET /api/bots": { bots: [bot] },
      "GET /api/threads?workspaceId=ws_1&limit=50": { threads: [passed] },
      "GET /api/threads/thr_1": { thread: passed, members },
      "GET /api/workspaces/ws_1": workspaceView(),
      "GET /api/threads/thr_1/messages": { messages: [] },
      "GET /api/runs?threadId=thr_1": { runs: [] },
      "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
      "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [] },
    });
    render(<ThreadScreen threadId={THREAD_ID} api={createApiClient({ fetch })} />);
    const deadline = await screen.findByTestId("thread-deadline");
    expect(deadline.textContent).toContain("Deadline");
    expect(deadline.textContent).toContain("passed");
    expect(deadline.getAttribute("title")).toBe("2020-01-01T00:00:00.000Z");
  });

  it("shows no deadline for a thread without one", async () => {
    const { fetch } = fakeFetch({
      "GET /api/bots/bot_1/screen": { state: "stopped", humanHeld: false },
      "GET /api/bots/bot_2/screen": { state: "stopped", humanHeld: false },
      "GET /api/workspaces": { workspaces: [workspace] },
      "GET /api/bots": { bots: [bot] },
      "GET /api/threads?workspaceId=ws_1&limit=50": { threads: [thread] },
      "GET /api/threads/thr_1": { thread, members },
      "GET /api/workspaces/ws_1": workspaceView(),
      "GET /api/threads/thr_1/messages": { messages: [] },
      "GET /api/runs?threadId=thr_1": { runs: [] },
      "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
      "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [] },
    });
    render(<ThreadScreen threadId={THREAD_ID} api={createApiClient({ fetch })} />);
    await screen.findByLabelText("Transcript");
    expect(screen.queryByTestId("thread-deadline")).toBeNull();
  });

  it("posts {body}, shows the typing indicator, then appends the bot reply from SSE", async () => {
    const human = message(4, "human", "hello bot");
    const { fetch, calls } = fakeFetch({
      "GET /api/bots/bot_1/screen": { state: "stopped", humanHeld: false },
      "GET /api/bots/bot_2/screen": { state: "stopped", humanHeld: false },
      "GET /api/workspaces": { workspaces: [workspace] },
      "GET /api/bots": { bots: [bot] },
      "GET /api/threads?workspaceId=ws_1&limit=50": { threads: [thread] },
      "GET /api/threads/thr_1": { thread, members },
      "GET /api/workspaces/ws_1": workspaceView(),
      "GET /api/threads/thr_1/messages": { messages: transcript },
      "GET /api/runs?threadId=thr_1": { runs: [] },
      "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
      "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [] },
      "POST /api/threads/thr_1/messages": { message: human, runs: [run({ status: "queued" })] },
    });
    render(<ThreadScreen threadId={THREAD_ID} api={createApiClient({ fetch })} />);
    await screen.findByText("check the console");

    const box = screen.getByLabelText("Message");
    fireEvent.change(box, { target: { value: "hello bot" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await screen.findByText("hello bot");
    const post = calls.find((c) => c.method === "POST");
    expect(post).toEqual({
      method: "POST",
      path: "/api/threads/thr_1/messages",
      body: { body: "hello bot" },
    });
    expect((box as HTMLTextAreaElement).value).toBe("");

    const typing = await screen.findByTestId("typing");
    expect(typing.textContent).toContain("ops");
    expect(typing.textContent).toContain("is queued");

    const es = FakeEventSource.forUrl("/api/events?threadId=thr_1");
    es.emit({ type: "run_status", threadId: THREAD_ID, run: run({ status: "running" }) });
    await waitFor(() => expect(screen.getByTestId("typing").textContent).toContain("is running"));

    es.emit({
      type: "thread_message",
      threadId: THREAD_ID,
      message: message(5, "bot", "done, all green", { runId: RUN_ID }),
    });
    es.emit({ type: "run_status", threadId: THREAD_ID, run: run({ status: "succeeded" }) });
    await screen.findByText("done, all green");
    await waitFor(() => expect(screen.queryByTestId("typing")).toBeNull());
    const list = screen.getByLabelText("Transcript");
    const bodies = within(list)
      .getAllByRole("listitem")
      .map((r) => r.querySelector(".body")?.textContent);
    expect(bodies.at(-1)).toBe("done, all green");
  });

  it("does not let a late queued POST response replace a running SSE update", async () => {
    const human = message(4, "human", "start now");
    let resolvePost: ((value: unknown) => void) | undefined;
    const { fetch, calls } = fakeFetch({
      "GET /api/bots/bot_1/screen": { state: "stopped", humanHeld: false },
      "GET /api/bots/bot_2/screen": { state: "stopped", humanHeld: false },
      "GET /api/workspaces": { workspaces: [workspace] },
      "GET /api/bots": { bots: [bot] },
      "GET /api/threads?workspaceId=ws_1&limit=50": { threads: [thread] },
      "GET /api/threads/thr_1": { thread, members },
      "GET /api/workspaces/ws_1": workspaceView(),
      "GET /api/threads/thr_1/messages": { messages: transcript },
      "GET /api/runs?threadId=thr_1": { runs: [] },
      "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
      "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [] },
      "POST /api/threads/thr_1/messages": () =>
        new Promise((resolve) => {
          resolvePost = resolve;
        }),
    });
    render(<ThreadScreen threadId={THREAD_ID} api={createApiClient({ fetch })} />);
    await screen.findByText("check the console");

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "start now" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(calls.some((call) => call.method === "POST" && call.path.endsWith("/messages"))).toBe(
        true,
      ),
    );

    FakeEventSource.forUrl(`/api/events?threadId=${THREAD_ID}`).emit({
      type: "run_status",
      threadId: THREAD_ID,
      run: run({ status: "running" }),
    });
    await waitFor(() => expect(screen.getByTestId("typing").textContent).toContain("is running"));

    resolvePost?.({ message: human, runs: [run({ status: "queued" })] });
    await screen.findByText("start now");
    await waitFor(() => expect(screen.getByTestId("typing").textContent).toContain("is running"));
  });

  it("does not let send A finishing clear draft B typed while it was pending", async () => {
    let resolvePost: ((value: unknown) => void) | undefined;
    const { fetch } = fakeFetch({
      "GET /api/bots/bot_1/screen": { state: "stopped", humanHeld: false },
      "GET /api/bots/bot_2/screen": { state: "stopped", humanHeld: false },
      "GET /api/workspaces": { workspaces: [workspace] },
      "GET /api/bots": { bots: [bot] },
      "GET /api/threads?workspaceId=ws_1&limit=50": { threads: [thread] },
      "GET /api/threads/thr_1": { thread, members },
      "GET /api/workspaces/ws_1": workspaceView(),
      "GET /api/threads/thr_1/messages": { messages: transcript },
      "GET /api/runs?threadId=thr_1": { runs: [] },
      "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
      "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [] },
      "POST /api/threads/thr_1/messages": () =>
        new Promise((resolve) => {
          resolvePost = resolve;
        }),
    });
    render(<ThreadScreen threadId={THREAD_ID} api={createApiClient({ fetch })} />);
    await screen.findByText("check the console");

    const box = screen.getByLabelText("Message") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "A" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(box.value).toBe(""));
    fireEvent.change(box, { target: { value: "B" } });

    resolvePost?.({ message: message(4, "human", "A"), runs: [] });
    await screen.findByText("A");
    expect(box.value).toBe("B");
  });

  it("retains a failed send separately until the operator restores it", async () => {
    const { fetch } = fakeFetch({
      "GET /api/bots/bot_1/screen": { state: "stopped", humanHeld: false },
      "GET /api/bots/bot_2/screen": { state: "stopped", humanHeld: false },
      "GET /api/workspaces": { workspaces: [workspace] },
      "GET /api/bots": { bots: [bot] },
      "GET /api/threads?workspaceId=ws_1&limit=50": { threads: [thread] },
      "GET /api/threads/thr_1": { thread, members },
      "GET /api/workspaces/ws_1": workspaceView(),
      "GET /api/threads/thr_1/messages": { messages: transcript },
      "GET /api/runs?threadId=thr_1": { runs: [] },
      "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
      "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [] },
      "POST /api/threads/thr_1/messages": new Error("send failed"),
    });
    render(<ThreadScreen threadId={THREAD_ID} api={createApiClient({ fetch })} />);
    await screen.findByText("check the console");

    const box = screen.getByLabelText("Message") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "please retry" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await screen.findByText("Message failed to send: send failed");
    expect(box.value).toBe("");
    expect(screen.getByText("please retry")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore failed message" }));
    expect(box.value).toBe("please retry");
  });

  it("does not overwrite draft B when pending send A fails", async () => {
    let resolvePost: ((value: unknown) => void) | undefined;
    const { fetch } = fakeFetch({
      "GET /api/bots/bot_1/screen": { state: "stopped", humanHeld: false },
      "GET /api/bots/bot_2/screen": { state: "stopped", humanHeld: false },
      "GET /api/workspaces": { workspaces: [workspace] },
      "GET /api/bots": { bots: [bot] },
      "GET /api/threads?workspaceId=ws_1&limit=50": { threads: [thread] },
      "GET /api/threads/thr_1": { thread, members },
      "GET /api/workspaces/ws_1": workspaceView(),
      "GET /api/threads/thr_1/messages": { messages: transcript },
      "GET /api/runs?threadId=thr_1": { runs: [] },
      "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
      "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [] },
      "POST /api/threads/thr_1/messages": () =>
        new Promise((resolve) => {
          resolvePost = resolve;
        }),
    });
    render(<ThreadScreen threadId={THREAD_ID} api={createApiClient({ fetch })} />);
    await screen.findByText("check the console");

    const box = screen.getByLabelText("Message") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "A" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.change(box, { target: { value: "B" } });
    resolvePost?.(new Error("send A failed"));

    await screen.findByText("Message failed to send: send A failed");
    expect(box.value).toBe("B");
    expect(screen.getByText("A")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Replace draft with failed message" }));
    expect(box.value).toBe("A");
  });

  it("keeps a failed pending submission recoverable after navigating away", async () => {
    const secondId = "thr_2" as ThreadId;
    const secondThread = { ...thread, id: secondId, title: "Second thread" };
    const secondMembers = members.map((member) => ({ ...member, threadId: secondId }));
    let resolvePost: ((value: unknown) => void) | undefined;
    const { fetch } = fakeFetch({
      "GET /api/bots/bot_1/screen": { state: "stopped", humanHeld: false },
      "GET /api/bots/bot_2/screen": { state: "stopped", humanHeld: false },
      "GET /api/workspaces": { workspaces: [workspace] },
      "GET /api/bots": { bots: [bot] },
      "GET /api/threads?workspaceId=ws_1&limit=50": { threads: [thread, secondThread] },
      "GET /api/threads/thr_1": { thread, members },
      "GET /api/threads/thr_2": { thread: secondThread, members: secondMembers },
      "GET /api/workspaces/ws_1": workspaceView(),
      "GET /api/threads/thr_1/messages": { messages: transcript },
      "GET /api/threads/thr_2/messages": { messages: [] },
      "GET /api/runs?threadId=thr_1": { runs: [] },
      "GET /api/runs?threadId=thr_2": { runs: [] },
      "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
      "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [] },
      "GET /api/approvals?status=pending&threadId=thr_2": { approvals: [] },
      "GET /api/approvals?status=decided&threadId=thr_2": { approvals: [] },
      "POST /api/threads/thr_1/messages": () =>
        new Promise((resolve) => {
          resolvePost = resolve;
        }),
    });
    const api = createApiClient({ fetch });
    const view = render(<ThreadScreen threadId={THREAD_ID} api={api} />);
    await screen.findByText("check the console");
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "pending A" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    view.rerender(<ThreadScreen threadId={secondId} api={api} />);
    expect(await screen.findAllByRole("heading", { name: "Second thread" })).not.toHaveLength(0);
    resolvePost?.(new Error("offline while away"));
    await Promise.resolve();

    view.rerender(<ThreadScreen threadId={THREAD_ID} api={api} />);
    await screen.findByText("Message failed to send: offline while away");
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Restore failed message" }));
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("pending A");
  });

  it("keeps a separate in-memory draft for each thread while navigating", async () => {
    const secondId = "thr_2" as ThreadId;
    const secondThread = { ...thread, id: secondId, title: "Second thread" };
    const secondMembers = members.map((member) => ({ ...member, threadId: secondId }));
    const { fetch } = fakeFetch({
      "GET /api/bots/bot_1/screen": { state: "stopped", humanHeld: false },
      "GET /api/bots/bot_2/screen": { state: "stopped", humanHeld: false },
      "GET /api/workspaces": { workspaces: [workspace] },
      "GET /api/bots": { bots: [bot] },
      "GET /api/threads?workspaceId=ws_1&limit=50": { threads: [thread, secondThread] },
      "GET /api/threads/thr_1": { thread, members },
      "GET /api/threads/thr_2": { thread: secondThread, members: secondMembers },
      "GET /api/workspaces/ws_1": workspaceView(),
      "GET /api/threads/thr_1/messages": { messages: transcript },
      "GET /api/threads/thr_2/messages": { messages: [] },
      "GET /api/runs?threadId=thr_1": { runs: [] },
      "GET /api/runs?threadId=thr_2": { runs: [] },
      "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
      "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [] },
      "GET /api/approvals?status=pending&threadId=thr_2": { approvals: [] },
      "GET /api/approvals?status=decided&threadId=thr_2": { approvals: [] },
    });
    const api = createApiClient({ fetch });
    const view = render(<ThreadScreen threadId={THREAD_ID} api={api} />);
    await screen.findByText("check the console");
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "draft one" } });

    view.rerender(<ThreadScreen threadId={secondId} api={api} />);
    expect(await screen.findAllByRole("heading", { name: "Second thread" })).not.toHaveLength(0);
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("");
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "draft two" } });

    view.rerender(<ThreadScreen threadId={THREAD_ID} api={api} />);
    await screen.findByText("check the console");
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("draft one");

    view.rerender(<ThreadScreen threadId={secondId} api={api} />);
    expect(await screen.findAllByRole("heading", { name: "Second thread" })).not.toHaveLength(0);
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("draft two");
  });

  it("keeps failed and cancelled runs visible when no bot reply exists", async () => {
    const failed = run({ status: "failed", error: "model request timed out" });
    const cancelled = run({
      id: "run_cancelled" as RunId,
      status: "cancelled",
      createdAt: "2026-09-21T10:01:00.000Z",
    });
    const { fetch } = fakeFetch({
      "GET /api/bots/bot_1/screen": { state: "stopped", humanHeld: false },
      "GET /api/bots/bot_2/screen": { state: "stopped", humanHeld: false },
      "GET /api/workspaces": { workspaces: [workspace] },
      "GET /api/bots": { bots: [bot] },
      "GET /api/threads?workspaceId=ws_1&limit=50": { threads: [thread] },
      "GET /api/threads/thr_1": { thread, members },
      "GET /api/workspaces/ws_1": workspaceView(),
      "GET /api/threads/thr_1/messages": { messages: [message(1, "human", "do it")] },
      "GET /api/runs?threadId=thr_1": { runs: [failed, cancelled] },
      "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
      "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [] },
    });
    render(<ThreadScreen threadId={THREAD_ID} api={createApiClient({ fetch })} />);

    await screen.findByText("model request timed out");
    expect(screen.getByText("This run was cancelled.")).toBeTruthy();
    const links = screen.getAllByRole("link", { name: "View run details" });
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      `#/runs/${failed.id}`,
      `#/runs/${cancelled.id}`,
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Show chat info" }));
    const member = within(screen.getByLabelText("Thread members")).getByText("ops").closest("li");
    expect(member?.textContent).toContain("cancelled");
    expect(member?.textContent).not.toContain("ready");
  });

  it("recovers messages and runs emitted while the stream was down, without replacing state", async () => {
    const recovered = message(4, "bot", "recovered reply", { runId: RUN_ID });
    const { fetch, calls } = fakeFetch({
      "GET /api/bots/bot_1/screen": { state: "stopped", humanHeld: false },
      "GET /api/bots/bot_2/screen": { state: "stopped", humanHeld: false },
      "GET /api/workspaces": { workspaces: [workspace] },
      "GET /api/bots": { bots: [bot] },
      "GET /api/threads?workspaceId=ws_1&limit=50": { threads: [thread] },
      "GET /api/threads/thr_1": { thread, members },
      "GET /api/workspaces/ws_1": workspaceView(),
      "GET /api/threads/thr_1/messages": { messages: transcript },
      // The refetch asks only for what the pane does not already hold.
      "GET /api/threads/thr_1/messages?afterSeq=3": { messages: [recovered] },
      "GET /api/runs?threadId=thr_1": { runs: [run({ status: "running" })] },
      "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
      "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [] },
    });
    render(<ThreadScreen threadId={THREAD_ID} api={createApiClient({ fetch })} />);
    await screen.findByText("check the console");
    await screen.findByTestId("typing");

    // The browser drops the stream and gets it back; the frames sent meanwhile are never replayed.
    const es = FakeEventSource.forUrl("/api/events?threadId=thr_1");
    es.drop();
    es.open();

    await screen.findByText("recovered reply");
    expect(calls.map((c) => c.path)).toContain("/api/threads/thr_1/messages?afterSeq=3");
    // The history the first fetch returned is still there, in order, exactly once.
    const list = screen.getByLabelText("Transcript");
    const bodies = within(list)
      .getAllByRole("listitem")
      .map((r) => r.querySelector(".body")?.textContent)
      .filter((b) => b !== undefined);
    expect(bodies).toEqual(["check the console", "ops joined", "on it", "recovered reply"]);
  });

  it("does not send on the Enter that commits an IME composition", async () => {
    const human = message(4, "human", "你好");
    const { fetch, calls } = fakeFetch({
      "GET /api/bots/bot_1/screen": { state: "stopped", humanHeld: false },
      "GET /api/bots/bot_2/screen": { state: "stopped", humanHeld: false },
      "GET /api/workspaces": { workspaces: [workspace] },
      "GET /api/bots": { bots: [bot] },
      "GET /api/threads?workspaceId=ws_1&limit=50": { threads: [thread] },
      "GET /api/threads/thr_1": { thread, members },
      "GET /api/workspaces/ws_1": workspaceView(),
      "GET /api/threads/thr_1/messages": { messages: transcript },
      "GET /api/runs?threadId=thr_1": { runs: [] },
      "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
      "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [] },
      "POST /api/threads/thr_1/messages": { message: human, runs: [] },
    });
    render(<ThreadScreen threadId={THREAD_ID} api={createApiClient({ fetch })} />);
    await screen.findByText("check the console");

    const box = screen.getByLabelText("Message") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "你好" } });

    // Enter while a candidate window is open commits the candidate; it must not post.
    fireEvent.keyDown(box, { key: "Enter", isComposing: true });
    // Some IMEs report the composing Enter only through the legacy keyCode.
    fireEvent.keyDown(box, { key: "Enter", keyCode: 229 });
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(false));
    expect(box.value).toBe("你好");

    // The next Enter, with the composition closed, does send.
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(1));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ body: "你好" });
  });

  it("creates workspace, bot and thread from the first-run form on an empty database", async () => {
    const created = (method: string, path: string) =>
      calls.some((call) => call.method === method && call.path === path);
    const { fetch, calls } = fakeFetch({
      "GET /api/workspaces": { workspaces: [] },
      "GET /api/bots": () => ({ bots: created("POST", "/api/bots") ? [bot] : [] }),
      "GET /api/threads?workspaceId=ws_1&limit=50": () => ({
        threads: created("POST", "/api/bots")
          ? [{ ...thread, memberIds: [BOT_ID], privateChatBotId: BOT_ID }]
          : [],
      }),
      "POST /api/workspaces": { workspace },
      "POST /api/bots": { bot },
      "POST /api/bots/bot_1/private-chat": { thread, members },
    });
    render(<ThreadScreen api={createApiClient({ fetch })} />);
    const form = await screen.findByLabelText("First run");
    fireEvent.change(within(form).getByLabelText("Workspace name"), {
      target: { value: "default" },
    });
    fireEvent.click(within(form).getByLabelText(/Only these sites/));
    fireEvent.change(within(form).getByLabelText(/Allowed domains/), {
      target: { value: "example.com\n*.example.org" },
    });
    fireEvent.change(within(form).getByLabelText("Bot name"), { target: { value: "ops" } });
    fireEvent.change(within(form).getByLabelText("Bot role"), { target: { value: "operator" } });
    fireEvent.submit(form);

    await waitFor(() => expect(window.location.hash).toBe(`#/threads/${THREAD_ID}`));
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toEqual([
      {
        method: "POST",
        path: "/api/workspaces",
        body: { name: "default", egressAllowlist: ["example.com", "*.example.org"] },
      },
      {
        method: "POST",
        path: "/api/bots",
        body: { name: "ops", role: "operator", workspaceId: WS_ID },
      },
      { method: "POST", path: "/api/bots/bot_1/private-chat", body: {} },
    ]);
    // The new thread appears in the rail from the create response; the refetch keeps it.
    await within(screen.getByRole("complementary")).findByText("ops");
    expect(screen.queryByLabelText("First run")).toBeNull();
  });

  it("creates a group of up to six bots from the current workspace only", async () => {
    const otherWorkspace: Workspace = { ...workspace, id: "ws_2" as WorkspaceId, name: "other" };
    const makeBot = (index: number, workspaceId: WorkspaceId): BotDefinition => ({
      ...bot,
      id: `bot_${index}` as BotId,
      name: `bot${index}`,
      role: `role ${index}`,
      workspaceId,
    });
    const firstWorkspaceBots = Array.from({ length: 7 }, (_, index) => makeBot(index + 1, WS_ID));
    const otherWorkspaceBots = [makeBot(8, otherWorkspace.id), makeBot(9, otherWorkspace.id)];
    const routes = {
      "GET /api/workspaces": { workspaces: [workspace, otherWorkspace] },
      "GET /api/bots": { bots: [...firstWorkspaceBots, ...otherWorkspaceBots] },
      "GET /api/threads?workspaceId=ws_1&limit=50": { threads: [] },
      "GET /api/threads?workspaceId=ws_2&limit=50": { threads: [] },
      "POST /api/threads": { thread: { ...thread, workspaceId: otherWorkspace.id }, members: [] },
    };
    const first = fakeFetch(routes);
    const view = render(<ThreadScreen api={createApiClient({ fetch: first.fetch })} />);

    // Without a provider the screen scopes itself to the first workspace: seven candidates,
    // the first two preselected, the seventh disabled once six are chosen. With bots listed as
    // inboxes the dialog no longer opens by itself (issue #29).
    fireEvent.click(await screen.findByRole("button", { name: "New chat" }));
    const form = await screen.findByLabelText("New thread");
    const initialChoices = within(form).getAllByRole("checkbox") as HTMLInputElement[];
    expect(initialChoices).toHaveLength(7);
    expect(initialChoices[0]?.checked).toBe(true);
    expect(initialChoices[1]?.checked).toBe(true);
    for (const choice of initialChoices.slice(2, 6)) fireEvent.click(choice);
    expect(initialChoices[6]?.disabled).toBe(true);
    expect(within(form).getByText("6 of 6 selected")).toBeTruthy();
    view.unmount();

    // Under the app shell the selected workspace decides which bots the form offers.
    const { fetch, calls } = fakeFetch(routes);
    const api = createApiClient({ fetch });
    render(
      <WorkspaceScopeProvider api={api} initialWorkspaceId={otherWorkspace.id}>
        <ThreadScreen api={api} />
      </WorkspaceScopeProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "New chat" }));
    const otherForm = await screen.findByLabelText("New thread");
    const otherChoices = within(otherForm).getAllByRole("checkbox") as HTMLInputElement[];
    expect(otherChoices).toHaveLength(2);
    expect(otherChoices[0]?.checked).toBe(true);
    expect(otherChoices[1]?.checked).toBe(true);
    fireEvent.submit(otherForm);

    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true));
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({
      workspaceId: otherWorkspace.id,
      botIds: otherWorkspaceBots.map((candidate) => candidate.id),
    });
  });

  it("shows group activity, a handoff link, and resumes a budget-paused thread", async () => {
    const reviewer: BotDefinition = {
      ...bot,
      id: "bot_2" as BotId,
      name: "reviewer",
      role: "review",
    };
    const groupMembers = [members[0], { ...members[0], botId: reviewer.id, name: reviewer.name }];
    const pausedThread = { ...thread, status: "paused" as const };
    const handoff = message(4, "system", "ops handed off to reviewer.", {
      attachments: [
        {
          name: "Open conversation",
          mimeType: THREAD_LINK_ATTACHMENT_MIME,
          ref: "thr_bus",
        },
      ],
    });
    let detailCalls = 0;
    const { fetch } = fakeFetch({
      "GET /api/bots/bot_1/screen": { state: "stopped", humanHeld: false },
      "GET /api/bots/bot_2/screen": { state: "stopped", humanHeld: false },
      "GET /api/workspaces": { workspaces: [workspace] },
      "GET /api/bots": { bots: [bot, reviewer] },
      "GET /api/threads?workspaceId=ws_1&limit=50": { threads: [pausedThread] },
      "GET /api/threads/thr_1": () => {
        detailCalls += 1;
        return {
          thread: detailCalls === 1 ? pausedThread : { ...pausedThread, status: "active" },
          members: groupMembers,
        };
      },
      "GET /api/workspaces/ws_1": workspaceView({ bots: [bot, reviewer] }),
      "GET /api/threads/thr_1/messages": { messages: [...transcript, handoff] },
      "GET /api/runs?threadId=thr_1": {
        runs: [
          run({ id: "run_ops" as RunId, botId: bot.id, status: "running" }),
          run({ id: "run_review" as RunId, botId: reviewer.id, status: "waiting_browser" }),
        ],
      },
      "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
      "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [] },
      "POST /api/threads/thr_1/messages": {
        message: message(5, "human", "continue"),
        runs: [],
      },
    });
    render(<ThreadScreen threadId={THREAD_ID} api={createApiClient({ fetch })} />);

    fireEvent.click(await screen.findByRole("button", { name: "Show chat info" }));
    const memberList = await screen.findByLabelText("Thread members");
    expect(within(memberList).getByText("ops").closest("li")?.textContent).toContain("running");
    expect(within(memberList).getByText("reviewer").closest("li")?.textContent).toContain(
      "waiting browser",
    );
    fireEvent.click(screen.getByRole("button", { name: "Hide chat info" }));
    expect(screen.getByRole("status").textContent).toContain("Send a new message to resume");
    const handoffLink = screen.getByRole("link", { name: "Open conversation" });
    expect(handoffLink.getAttribute("href")).toBe("#/threads/thr_bus");
    expect(handoffLink.closest("li")?.querySelector(".author")?.textContent).toBe("handoff");

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "continue" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.queryByRole("status", { hidden: true })).toBeNull());
    await waitFor(() => expect(detailCalls).toBeGreaterThan(1));
  });

  it("renders a legacy handoff attachment from a persisted transcript", async () => {
    const legacyHandoff = message(4, "system", "ops handed off to reviewer.", {
      attachments: [
        {
          name: "Open conversation",
          mimeType: "application/x-cogbot-thread",
          ref: "thr_bus",
        },
      ],
    });
    const { fetch } = fakeFetch({
      "GET /api/bots/bot_1/screen": { state: "stopped", humanHeld: false },
      "GET /api/workspaces": { workspaces: [workspace] },
      "GET /api/bots": { bots: [bot] },
      "GET /api/threads?workspaceId=ws_1&limit=50": { threads: [thread] },
      "GET /api/threads/thr_1": { thread, members },
      "GET /api/workspaces/ws_1": workspaceView(),
      "GET /api/threads/thr_1/messages": { messages: [...transcript, legacyHandoff] },
      "GET /api/runs?threadId=thr_1": { runs: [] },
      "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
      "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [] },
    });
    render(<ThreadScreen threadId={THREAD_ID} api={createApiClient({ fetch })} />);

    const link = await screen.findByRole("link", { name: "Open conversation" });
    expect(link.getAttribute("href")).toBe("#/threads/thr_bus");
    expect(link.closest("li")?.querySelector(".author")?.textContent).toBe("handoff");
  });

  it("refreshes membership and paused state without letting a stale detail response win", async () => {
    const reviewer = {
      ...bot,
      id: "bot_2" as BotId,
      name: "reviewer",
    };
    const groupMembers = [members[0], { ...members[0], botId: reviewer.id, name: reviewer.name }];
    let resolveInitial: ((value: unknown) => void) | undefined;
    let detailCalls = 0;
    const { fetch } = fakeFetch({
      "GET /api/bots/bot_1/screen": { state: "stopped", humanHeld: false },
      "GET /api/bots/bot_2/screen": { state: "stopped", humanHeld: false },
      "GET /api/workspaces": { workspaces: [workspace] },
      "GET /api/bots": { bots: [bot, reviewer] },
      "GET /api/threads?workspaceId=ws_1&limit=50": { threads: [thread] },
      "GET /api/threads/thr_1": () => {
        detailCalls += 1;
        if (detailCalls === 1) {
          return new Promise((resolve) => {
            resolveInitial = resolve;
          });
        }
        if (detailCalls === 2)
          return { thread: { ...thread, status: "paused" }, members: groupMembers };
        return { thread, members: groupMembers };
      },
      "GET /api/workspaces/ws_1": workspaceView({ bots: [bot, reviewer] }),
      "GET /api/threads/thr_1/messages": { messages: transcript },
      "GET /api/threads/thr_1/messages?afterSeq=3": { messages: [] },
      "GET /api/runs?threadId=thr_1": { runs: [] },
      "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
      "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [] },
    });
    render(<ThreadScreen threadId={THREAD_ID} api={createApiClient({ fetch })} />);

    const stream = await waitFor(() => FakeEventSource.forUrl(`/api/events?threadId=${THREAD_ID}`));
    stream.emit({
      type: "run_status",
      threadId: THREAD_ID,
      run: run({ status: "running" }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Show chat info" }));
    expect((await screen.findByLabelText("Thread members")).textContent).toContain("reviewer");
    expect(screen.getByRole("status", { hidden: true })).toBeTruthy();

    resolveInitial?.({ thread, members });
    await screen.findByText("check the console");
    expect(screen.getByLabelText("Thread members").textContent).toContain("reviewer");
    expect(screen.getByRole("status", { hidden: true })).toBeTruthy();

    stream.drop();
    stream.open();
    await waitFor(() => expect(screen.queryByRole("status", { hidden: true })).toBeNull());
    expect(screen.getByLabelText("Thread members").textContent).toContain("reviewer");
  });

  it("updates a new chat's rail preview when its first messages arrive", async () => {
    const created = { ...thread, title: undefined };
    const peer = { ...bot, id: "bot_2" as BotId, name: "peer" };
    const human = message(1, "human", "say ok");
    const reply = message(2, "bot", "UI_SMOKE_OK", { runId: RUN_ID });
    let listed: unknown[] = [];
    const summary = (last: ReturnType<typeof message>) => ({
      ...created,
      memberIds: [BOT_ID, peer.id],
      lastMessage: {
        seq: last.seq,
        authorKind: last.authorKind,
        authorId: last.authorId,
        excerpt: last.body,
        ts: last.ts,
      },
    });
    const { fetch } = fakeFetch({
      "GET /api/bots/bot_1/screen": { state: "stopped", humanHeld: false },
      "GET /api/workspaces": { workspaces: [workspace] },
      "GET /api/bots": { bots: [bot, peer] },
      "GET /api/threads?workspaceId=ws_1&limit=50": () => ({ threads: listed }),
      "POST /api/threads": () => {
        listed = [{ ...created, memberIds: [BOT_ID, peer.id] }];
        return { thread: created, members };
      },
      "GET /api/threads/thr_1": { thread: created, members },
      "GET /api/workspaces/ws_1": workspaceView(),
      "GET /api/threads/thr_1/messages": { messages: [] },
      "GET /api/runs?threadId=thr_1": { runs: [] },
      "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
      "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [] },
    });
    const api = createApiClient({ fetch });
    const view = render(<ThreadScreen api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "New chat" }));
    fireEvent.submit(await screen.findByLabelText("New thread"));
    await waitFor(() => expect(window.location.hash).toBe(`#/threads/${THREAD_ID}`));
    view.rerender(<ThreadScreen threadId={THREAD_ID} api={api} />);
    const rail = screen.getByRole("complementary");
    await within(rail).findByText("No messages yet");
    // The group is the only existing chat row.
    const rows = within(rail).getAllByRole("listitem").length;
    await screen.findByLabelText("Transcript");

    const feed = FakeEventSource.forUrl("/api/events");
    listed = [summary(human)];
    feed.emit({ type: "thread_message", threadId: THREAD_ID, message: human });
    await within(rail).findByText("say ok");

    listed = [summary(reply)];
    feed.emit({ type: "thread_message", threadId: THREAD_ID, message: reply });
    await within(rail).findByText("UI_SMOKE_OK");
    expect(within(rail).queryByText("No messages yet")).toBeNull();
    expect(rows).toBe(2);
    expect(within(rail).getAllByRole("listitem")).toHaveLength(3);
  });

  // A list refresh for another chat's message can be in flight while a chat is created. Its
  // answer is either from before the chat existed (it would drop the new row) or from after
  // (the create response would then add the same row twice). Either way the new chat keeps one
  // row, and that row shows the first message's preview.
  for (const race of ["from before the chat existed", "from after the chat existed"] as const) {
    it(`keeps a new chat's one rail row when a racing list refresh is ${race}`, async () => {
      const peer = { ...bot, id: "bot_2" as BotId, name: "peer" };
      const older = { ...thread, id: "thr_0" as ThreadId, title: "Older chat" };
      const created = { ...thread, title: "Fresh chat", updatedAt: "2026-09-21T09:00:00.000Z" };
      const human = message(1, "human", "say ok");
      const summary = (t: Thread, last: ReturnType<typeof message>) => ({
        ...t,
        memberIds: t.id === THREAD_ID ? [BOT_ID, peer.id] : [BOT_ID],
        lastMessage: {
          seq: last.seq,
          authorKind: last.authorKind,
          authorId: last.authorId,
          excerpt: last.body,
          ts: last.ts,
        },
      });
      const olderRow = summary(older, message(5, "bot", "older reply"));
      let listCalls = 0;
      let answerSlowList: ((value: unknown) => void) | undefined;
      let answerCreate: ((value: unknown) => void) | undefined;
      let latest: unknown[] = [olderRow];
      const { fetch } = fakeFetch({
        "GET /api/bots/bot_1/screen": { state: "stopped", humanHeld: false },
        "GET /api/workspaces": { workspaces: [workspace] },
        "GET /api/bots": { bots: [bot, peer] },
        "GET /api/threads?workspaceId=ws_1&limit=50": () => {
          listCalls += 1;
          if (listCalls !== 2) return { threads: latest };
          return new Promise((resolve) => {
            answerSlowList = resolve;
          });
        },
        "POST /api/threads": () =>
          new Promise((resolve) => {
            answerCreate = resolve;
          }),
        "GET /api/threads/thr_1": { thread: created, members },
        "GET /api/workspaces/ws_1": workspaceView(),
        "GET /api/threads/thr_1/messages": { messages: [] },
        "GET /api/runs?threadId=thr_1": { runs: [] },
        "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
        "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [] },
      });
      const api = createApiClient({ fetch });
      const view = render(<ThreadScreen api={api} />);
      await screen.findByText("Older chat");
      const rail = screen.getByRole("complementary");
      const feed = FakeEventSource.forUrl("/api/events");
      feed.emit({ type: "thread_message", threadId: older.id, message: message(6, "bot", "x") });
      await waitFor(() => expect(answerSlowList).toBeDefined());

      fireEvent.click(within(rail).getByRole("button", { name: "New chat" }));
      fireEvent.submit(await screen.findByLabelText("New thread"));
      await waitFor(() => expect(answerCreate).toBeDefined());
      latest = [{ ...created, memberIds: [BOT_ID, peer.id] }, olderRow];
      if (race === "from before the chat existed") {
        answerCreate?.({ thread: created, members });
        await within(rail).findByText("Fresh chat");
        answerSlowList?.({ threads: [olderRow] });
      } else {
        answerSlowList?.({ threads: [{ ...created, memberIds: [BOT_ID, peer.id] }, olderRow] });
        await within(rail).findByText("Fresh chat");
        answerCreate?.({ thread: created, members });
      }
      await waitFor(() => expect(window.location.hash).toBe(`#/threads/${THREAD_ID}`));
      view.rerender(<ThreadScreen threadId={THREAD_ID} api={api} />);
      await screen.findByLabelText("Transcript");
      await waitFor(() => expect(within(rail).getAllByRole("listitem")).toHaveLength(3));
      expect(within(rail).getAllByText("Fresh chat")).toHaveLength(1);

      latest = [summary(created, human), olderRow];
      feed.emit({ type: "thread_message", threadId: THREAD_ID, message: human });
      await within(rail).findByText("say ok");
      expect(within(rail).queryByText("No messages yet")).toBeNull();
      expect(within(rail).getAllByRole("listitem")).toHaveLength(3);
    });
  }
});
