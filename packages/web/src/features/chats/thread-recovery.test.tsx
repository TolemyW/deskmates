// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiClient } from "../../api/client.js";
import { WorkspaceScopeProvider } from "../../state/workspace-scope.js";
import {
  FakeEventSource,
  THREAD_ID,
  bot,
  fakeFetch,
  installFakeEventSource,
  members,
  thread,
  workspace,
  workspaceView,
} from "../../test-support/fixtures.js";
import { ThreadScreen } from "./thread.js";

function fixture() {
  let offline = true;
  const available = <T,>(value: T): T => {
    if (offline) throw new TypeError("Failed to fetch");
    return value;
  };
  const wire = fakeFetch({
    "GET /api/bots/bot_1/screen": { state: "stopped", humanHeld: false },
    "GET /api/bots/bot_2/screen": { state: "stopped", humanHeld: false },
    "GET /api/workspaces": () => available({ workspaces: [workspace] }),
    "GET /api/bots": () => available({ bots: [bot] }),
    "GET /api/threads?workspaceId=ws_1&limit=50": () => available({ threads: [thread] }),
    "GET /api/threads/thr_1": { thread, members },
    "GET /api/workspaces/ws_1": workspaceView(),
    "GET /api/threads/thr_1/messages": { messages: [] },
    "GET /api/runs?botId=bot_1": { runs: [] },
    "GET /api/runs?threadId=thr_1": { runs: [] },
    "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
    "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [] },
  });
  return {
    api: createApiClient({ fetch: wire.fetch }),
    calls: wire.calls,
    online: () => {
      offline = false;
    },
    offline: () => {
      offline = true;
    },
  };
}

beforeEach(() => {
  installFakeEventSource();
  window.location.hash = `#/threads/${THREAD_ID}`;
});
afterEach(cleanup);

describe("chat fetch recovery (#73)", () => {
  it("does not infer an empty workspace from failed reads and retries the workspace and chat lists", async () => {
    const f = fixture();
    render(
      <WorkspaceScopeProvider api={f.api}>
        <ThreadScreen api={f.api} threadId={THREAD_ID} />
      </WorkspaceScopeProvider>,
    );
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("No chats yet.")).toBeNull();
    expect(screen.queryByLabelText("Workspace name")).toBeNull();
    f.online();
    fireEvent.click(retry);
    fireEvent.click(retry);
    await screen.findAllByText("Morning check");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(window.location.hash).toBe(`#/threads/${THREAD_ID}`);
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("recovers failed initial reads on the browser online event without requiring an SSE reconnect", async () => {
    const f = fixture();
    render(<ThreadScreen api={f.api} threadId={THREAD_ID} />);
    await screen.findByRole("button", { name: "Retry" });
    f.online();
    fireEvent(window, new Event("online"));
    await screen.findAllByText("Morning check");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("keeps the selected transcript and unsent draft during a background list failure", async () => {
    const f = fixture();
    f.online();
    render(<ThreadScreen api={f.api} threadId={THREAD_ID} />);
    await screen.findAllByText("Morning check");
    const composer = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(composer, { target: { value: "Keep this in-session draft" } });
    f.offline();
    act(() =>
      FakeEventSource.forUrl("/api/events").emit({ type: "thread_activity", threadId: THREAD_ID }),
    );
    await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByRole("textbox", { name: "Message" })).toBe(composer);
    expect((composer as HTMLTextAreaElement).value).toBe("Keep this in-session draft");
    f.online();
    fireEvent(window, new Event("online"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect((composer as HTMLTextAreaElement).value).toBe("Keep this in-session draft");
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  });
  it("restores a draft after offline navigation with the same API but never transfers it to another session", async () => {
    const f = fixture();
    f.online();
    const { rerender } = render(<ThreadScreen api={f.api} threadId={THREAD_ID} />);
    await screen.findAllByText("Morning check");
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Only this session" },
    });
    rerender(<div>Another screen</div>);
    f.offline();
    rerender(<ThreadScreen api={f.api} threadId={THREAD_ID} />);
    await screen.findByRole("button", { name: "Retry" });
    f.online();
    fireEvent(window, new Event("online"));
    await screen.findAllByText("Morning check");
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe(
      "Only this session",
    );
    const other = fixture();
    other.online();
    rerender(<ThreadScreen api={other.api} threadId={THREAD_ID} />);
    await screen.findAllByText("Morning check");
    await waitFor(() =>
      expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe(
        "",
      ),
    );
    expect(JSON.stringify(localStorage)).not.toContain("Only this session");
  });

  it("does not restore data from a delayed response belonging to the previous API client", async () => {
    let resolve!: (value: unknown) => void;
    const oldWire = fakeFetch({
      "GET /api/workspaces": { workspaces: [{ ...workspace, name: "Previous workspace" }] },
      "GET /api/bots": { bots: [bot] },
      "GET /api/threads?workspaceId=ws_1&limit=50": () =>
        new Promise((yes) => {
          resolve = yes;
        }),
    });
    const oldApi = createApiClient({ fetch: oldWire.fetch });
    const { rerender } = render(<ThreadScreen api={oldApi} threadId={THREAD_ID} />);
    // The rail asks for its workspace's page once the workspace is known (#113 slice CH).
    await waitFor(() =>
      expect(oldWire.calls.some((call) => call.path.startsWith("/api/threads?"))).toBe(true),
    );
    const f = fixture();
    f.online();
    rerender(<ThreadScreen api={f.api} threadId={THREAD_ID} />);
    await screen.findAllByText("Morning check");
    await act(async () =>
      resolve({ threads: [{ ...thread, title: "Previous tenant private chat" }] }),
    );
    expect(screen.queryByText("Previous tenant private chat")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
