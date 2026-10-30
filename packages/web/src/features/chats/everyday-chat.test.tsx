// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { createApiClient } from "../../api/client.js";
import { InterfaceViewProvider } from "../../lib/interface-view.js";
import {
  FakeEventSource,
  RUN_ID,
  THREAD_ID,
  approval,
  approvalMessage,
  bot,
  fakeFetch,
  installFakeEventSource,
  members,
  message,
  run,
  thread,
  workspaceView,
} from "../../test-support/fixtures.js";
import { ChatPane } from "./chat-pane.js";
import { ThreadRail } from "./thread-rail.js";

afterEach(cleanup);

it("switches diagnostics without losing the draft, and removes a failure when its retry progresses", async () => {
  installFakeEventSource();
  const failed = run({ status: "failed", error: "original internal failure" });
  const approvalRow = approval({ decision: "allow_once" });
  const { fetch, calls } = fakeFetch({
    "GET /api/threads/thr_1": { thread, members },
    "GET /api/threads/thr_1/messages": {
      messages: [
        message(1, "human", "Make the report"),
        message(2, "system", "Memory updated"),
        approvalMessage(3, "Already approved"),
      ],
    },
    "GET /api/runs?threadId=thr_1": {
      runs: [
        failed,
        run({
          id: "run_job" as typeof RUN_ID,
          status: "failed",
          createdAt: "2026-09-21T10:00:30.000Z",
          config: { runType: "activity_summary" },
        }),
      ],
    },
    "GET /api/runs?botId=bot_1": { runs: [] },
    "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
    "GET /api/approvals?threadId=thr_1&ids=apr_1": { approvals: [approvalRow] },
    "GET /api/workspaces/ws_1": workspaceView(),
  });
  const api = createApiClient({ fetch });
  function Preview() {
    const [view, setView] = useState<"use" | "tune">("use");
    return (
      <InterfaceViewProvider view={view}>
        <button type="button" onClick={() => setView(view === "use" ? "tune" : "use")}>
          Change view
        </button>
        <ChatPane api={api} threadId={THREAD_ID} />
      </InterfaceViewProvider>
    );
  }
  const { container } = render(<Preview />);
  await screen.findByText("Make the report");
  await waitFor(() => expect(container.querySelector(".run-outcome.failed")).toBeTruthy());
  expect(container.querySelector(".chat-header")?.textContent).not.toContain("failed");
  expect(screen.queryByText("Memory updated")).toBeNull();
  await waitFor(() => expect(container.querySelector(".chat-approval-receipt")).toBeTruthy());
  expect(container.querySelector(".chat-approval-receipt")).not.toHaveAttribute("open");
  const composer = screen.getByRole("textbox", { name: "Message" });
  fireEvent.change(composer, { target: { value: "Keep this draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Change view" }));
  expect(await screen.findByText("Memory updated")).toBeVisible();
  expect(await screen.findByTestId("approval-decision")).not.toBeVisible();
  expect(composer).toHaveValue("Keep this draft");
  fireEvent.click(screen.getByRole("button", { name: "Change view" }));
  act(() =>
    FakeEventSource.forUrl("/api/events?threadId=thr_1").emit({
      type: "run_status",
      threadId: THREAD_ID,
      run: run({
        id: `${RUN_ID}_retry` as typeof RUN_ID,
        status: "running",
        createdAt: "2026-09-21T10:01:00.000Z",
      }),
    }),
  );
  await waitFor(() => expect(container.querySelector(".run-outcome.failed")).toBeNull());
  expect(composer).toHaveValue("Keep this draft");
  fireEvent.click(screen.getByRole("button", { name: "Change view" }));
  expect(container.querySelector(".run-outcome.failed")).toBeTruthy();
  expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
});

it("does not expose a system protocol excerpt as a chat-list preview in Use", () => {
  const props = {
    workspace: workspaceView().workspace,
    bots: [bot],
    threads: [
      {
        ...thread,
        memberIds: [bot.id],
        lastMessage: {
          seq: 1,
          authorKind: "system" as const,
          authorId: "",
          excerpt: "Delegation outcome: internal transport",
          ts: thread.createdAt,
        },
      },
    ],
    onCreated: () => undefined,
  };
  const { rerender } = render(
    <InterfaceViewProvider view="use">
      <ThreadRail {...props} />
    </InterfaceViewProvider>,
  );
  expect(screen.queryByText(/internal transport/)).toBeNull();
  expect(screen.getByText("Activity updated")).toBeVisible();
  rerender(
    <InterfaceViewProvider view="tune">
      <ThreadRail {...props} />
    </InterfaceViewProvider>,
  );
  expect(screen.getByText(/internal transport/)).toBeVisible();
});
