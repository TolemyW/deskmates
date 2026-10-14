import type { RunId, ThreadId } from "@deskmates/contracts";
// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client.js";
import type { RunView } from "../../api/types.js";
import {
  BOT_ID,
  FakeEventSource,
  THREAD_ID,
  installFakeEventSource,
  run,
} from "../../test-support/fixtures.js";
import { PrivateChatActivity } from "./private-chat-activity.js";

beforeEach(installFakeEventSource);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("shows work from other chats and background runs, excludes local and existing handoff cards, and never writes", async () => {
  const other = run({
    id: "run_group" as RunId,
    threadId: "thr_group" as ThreadId,
    status: "running",
  });
  const listRuns = vi.fn(async () => ({
    runs: [other, run(), run({ id: "run_handoff" as RunId, threadId: "thr_bus" as ThreadId })],
  }));
  const api = { listRuns } as unknown as ApiClient;
  render(
    <PrivateChatActivity
      api={api}
      botId={BOT_ID}
      threadId={THREAD_ID}
      excludeRuns={["run_handoff"]}
    />,
  );
  // ADR-0033: one Activity card per run; the run record is behind "Original".
  const link = await screen.findByRole("link", { name: "Open chat" });
  expect(screen.getAllByTestId("activity-card")).toHaveLength(1);
  expect(link.getAttribute("href")).toBe("#/threads/thr_group");
  expect(listRuns).toHaveBeenCalledWith({ botId: BOT_ID });
  act(() =>
    FakeEventSource.instances[0]?.emit({
      type: "run_status",
      run: { ...other, status: "failed", error: "Tool failed" },
    }),
  );
  await screen.findByText("Tool failed");
  expect(screen.getAllByTestId("activity-card")).toHaveLength(1);
});

it("preserves a live update when an older initial snapshot resolves afterwards", async () => {
  let finish!: (rows: { runs: RunView[] }) => void;
  const listRuns = vi.fn(
    () =>
      new Promise<{ runs: RunView[] }>((resolve) => {
        finish = resolve;
      }),
  );
  render(
    <PrivateChatActivity
      api={{ listRuns } as unknown as ApiClient}
      botId={BOT_ID}
      threadId={THREAD_ID}
    />,
  );
  const other = run({ threadId: "thr_group" as ThreadId, status: "running" });
  act(() => FakeEventSource.instances[0]?.emit({ type: "run_status", run: other }));
  await screen.findAllByText("running");
  await act(async () => finish({ runs: [{ ...other, status: "queued" }] }));
  await waitFor(() => expect(screen.queryByText("queued")).toBeNull());
  expect(screen.getAllByText("running").length).toBeGreaterThan(0);
});
