// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { Task, TaskListPage } from "@deskmates/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import {
  BOT_ID,
  FakeEventSource,
  RUN_ID,
  THREAD_ID,
  WS_ID,
  bot,
  fakeFetch,
  message,
  run,
  task,
  workspace,
} from "../../test-support/fixtures.js";
import { TasksScreen } from "./tasks.js";

beforeEach(() => {
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
  window.history.replaceState(null, "");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setup(initial: Partial<Task> = {}) {
  let saved = task({
    ownerBotId: BOT_ID,
    status: "in_progress",
    threadIds: [THREAD_ID],
    runIds: [RUN_ID],
    ...initial,
  });
  const path = `/api/workspaces/${WS_ID}/tasks`;
  const wire = fakeFetch({
    "GET /api/workspaces": { workspaces: [workspace] },
    [`GET /api/bots?workspaceId=${WS_ID}`]: { bots: [bot] },
    [`GET /api/threads?workspaceId=${WS_ID}`]: { threads: [] },
    [`GET /api/runs?workspaceId=${WS_ID}&limit=100`]: { runs: [] },
    [`GET /api/workspaces/${WS_ID}/assets?offset=0&limit=100`]: {
      items: [],
      total: 0,
      offset: 0,
      limit: 100,
    },
    [`GET ${path}?offset=0&limit=25`]: () =>
      ({
        tasks: [saved],
        total: 1,
        offset: 0,
        limit: 25,
        statusCounts: {
          planned: 0,
          in_progress: 1,
          blocked: 0,
          delivered: 0,
          accepted: 0,
          cancelled: 0,
        },
      }) satisfies TaskListPage,
    [`GET ${path}/task_1`]: () => ({
      task: saved,
      execution: {
        observedAt: saved.updatedAt,
        submissions: [],
        linkedRuns: [],
        deliveries: [],
        latestCheckpoint: null,
      },
    }),
  });
  const api = createApiClient({ fetch: wire.fetch });
  return {
    api,
    calls: wire.calls,
    deliver: () => {
      saved = {
        ...saved,
        status: "delivered",
        version: saved.version + 1,
        deliveredAt: saved.updatedAt,
      };
    },
  };
}

it("refreshes the selected detail as well as the list without a page reload", async () => {
  const { api, deliver } = setup();
  render(<TasksScreen api={api} taskId="task_1" />);
  await screen.findByRole("button", { name: "Start work" });
  expect(screen.queryByRole("button", { name: "Accept delivery" })).toBeNull();
  deliver();
  fireEvent.click(screen.getByRole("button", { name: "Refresh task list" }));
  expect(await screen.findByRole("button", { name: "Accept delivery" })).toBeEnabled();
  expect(screen.getByRole("link", { name: /Awaiting review/ })).toBeVisible();
});

it.each(["run", "message", "reconnect"] as const)(
  "follows a recorded %s event into review without posting work",
  async (kind) => {
    const { api, deliver, calls } = setup();
    const get = vi.spyOn(api, "getTask");
    render(<TasksScreen api={api} taskId="task_1" />);
    await screen.findByRole("button", { name: "Start work" });
    const stream = FakeEventSource.forUrl("/api/events");
    act(() => stream.open());
    const before = get.mock.calls.length;
    act(() =>
      stream.emit({
        type: "run_status",
        run: run({
          id: "run_other" as typeof RUN_ID,
          threadId: "thr_other" as typeof THREAD_ID,
          status: "succeeded",
        }),
      }),
    );
    expect(get).toHaveBeenCalledTimes(before);
    deliver();
    act(() => {
      if (kind === "run") stream.emit({ type: "run_status", run: run({ status: "succeeded" }) });
      else if (kind === "message")
        stream.emit({
          type: "thread_message",
          threadId: THREAD_ID,
          message: message(2, "bot", "Delivered"),
        });
      else {
        stream.drop();
        stream.open();
      }
    });
    expect(await screen.findByRole("button", { name: "Accept delivery" })).toBeEnabled();
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  },
);

it("keeps the old base version and unsent edits when external delivery arrives", async () => {
  const { api, deliver } = setup();
  const get = vi.spyOn(api, "getTask");
  render(<TasksScreen api={api} taskId="task_1" />);
  await screen.findByRole("button", { name: "Start work" });
  fireEvent.click(screen.getByText("Edit goal"));
  fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "My unsent correction" } });
  const before = get.mock.calls.length;
  deliver();
  act(() =>
    FakeEventSource.forUrl("/api/events").emit({
      type: "run_status",
      run: run({ status: "succeeded" }),
    }),
  );
  await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(before));
  expect(await screen.findByRole("button", { name: "Reload and discard draft" })).toBeVisible();
  expect(screen.getByLabelText("Goal")).toHaveValue("My unsent correction");
  expect(screen.queryByRole("button", { name: "Accept delivery" })).toBeNull();
});

it("keeps unsent revision feedback instead of closing its form on an event", async () => {
  const { api, deliver } = setup({ status: "delivered" });
  const get = vi.spyOn(api, "getTask");
  render(<TasksScreen api={api} taskId="task_1" />);
  fireEvent.click(await screen.findByRole("button", { name: "Request changes" }));
  fireEvent.change(screen.getByLabelText("What should change?"), {
    target: { value: "Keep this unsent feedback" },
  });
  const before = get.mock.calls.length;
  deliver();
  act(() =>
    FakeEventSource.forUrl("/api/events").emit({
      type: "run_status",
      run: run({ status: "succeeded" }),
    }),
  );
  await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(before));
  expect(screen.getByLabelText("What should change?")).toHaveValue("Keep this unsent feedback");
});
