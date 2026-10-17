// @vitest-environment jsdom
import type { RunId, ThreadId } from "@deskmates/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import {
  ElsewhereActivityItem,
  ElsewhereActivityOlder,
  useElsewhereActivity,
} from "./private-chat-activity.js";

beforeEach(installFakeEventSource);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The rows as the chat pane mounts them: fed by the hook, in feed order. */
function Elsewhere({ api, exclude }: { api: ApiClient; exclude?: readonly string[] }) {
  const activity = useElsewhereActivity(api, { botId: BOT_ID, threadId: THREAD_ID }, exclude);
  return (
    <ol>
      <ElsewhereActivityOlder older={activity.older} />
      {activity.error ? <li role="alert">{activity.error}</li> : null}
      {activity.runs.map((item) => (
        <ElsewhereActivityItem key={item.id} run={item} api={api} botName={() => "ops"} />
      ))}
    </ol>
  );
}

it("shows work from other chats and background runs, excludes local runs, handoff cards and summary jobs, and never writes", async () => {
  const other = run({
    id: "run_group" as RunId,
    threadId: "thr_group" as ThreadId,
    status: "running",
  });
  const listRuns = vi.fn(async () => ({
    runs: [
      other,
      run(),
      run({ id: "run_handoff" as RunId, threadId: "thr_bus" as ThreadId }),
      run({
        id: "run_summary" as RunId,
        threadId: "thr_group" as ThreadId,
        config: { runType: "activity_summary" },
      }),
    ],
  }));
  const api = { listRuns } as unknown as ApiClient;
  render(<Elsewhere api={api} exclude={["run_handoff"]} />);
  // ADR-0033: one Activity card per run; the run record is behind "Original".
  const link = await screen.findByRole("link", { name: "Open chat" });
  expect(screen.getAllByTestId("activity-card")).toHaveLength(1);
  expect(link.getAttribute("href")).toBe("#/threads/thr_group");
  expect(screen.getByTestId("elsewhere-activity").textContent).toContain(
    "A message in another conversation",
  );
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
  render(<Elsewhere api={{ listRuns } as unknown as ApiClient} />);
  const other = run({ threadId: "thr_group" as ThreadId, status: "running" });
  act(() => FakeEventSource.instances[0]?.emit({ type: "run_status", run: other }));
  await screen.findAllByText("running");
  await act(async () => finish({ runs: [{ ...other, status: "queued" }] }));
  await waitFor(() => expect(screen.queryByText("queued")).toBeNull());
  expect(screen.getAllByText("running").length).toBeGreaterThan(0);
});

it("offers older finished work while the feed has a cursor", async () => {
  const listRuns = vi.fn(async (scope: { cursor?: string }) =>
    scope.cursor
      ? {
          runs: [
            run({ id: "run_old" as RunId, threadId: "thr_group" as ThreadId, status: "succeeded" }),
          ],
        }
      : { runs: [], nextCursor: "c1" },
  );
  render(<Elsewhere api={{ listRuns } as unknown as ApiClient} />);
  const older = await screen.findByRole("button", { name: "Load older activity" });
  fireEvent.click(older);
  await screen.findByTestId("activity-card");
  expect(listRuns).toHaveBeenLastCalledWith({ botId: BOT_ID, cursor: "c1" });
  expect(screen.queryByRole("button", { name: "Load older activity" })).toBeNull();
});
