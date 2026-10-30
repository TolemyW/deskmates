// @vitest-environment jsdom
// T1 (in-process), issue #106: the chat screen follows an opened chat into its workspace, but
// an operator switching workspace while a chat is open leaves that chat for the new workspace's
// chat list instead of being snapped back. The unsent draft of the chat that was open survives.

import type { BotDefinition, BotId, ThreadId, Workspace, WorkspaceId } from "@deskmates/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ApiClient, createApiClient } from "../../api/client.js";
import { useHashRoute } from "../../router.js";
import { WorkspaceScopeProvider, useWorkspaceScope } from "../../state/workspace-scope.js";
import {
  bot,
  fakeFetch,
  installFakeEventSource,
  members,
  message,
  thread,
  workspace,
  workspaceView,
} from "../../test-support/fixtures.js";
import { WorkspaceSwitcher } from "../workspaces/workspace-switcher.js";
import { ThreadScreen } from "./thread.js";

const otherWorkspace: Workspace = { ...workspace, id: "ws_2" as WorkspaceId, name: "research" };
const scout: BotDefinition = {
  ...bot,
  id: "bot_2" as BotId,
  name: "scout",
  workspaceId: otherWorkspace.id,
};
const otherId = "thr_2" as ThreadId;
const otherThread = {
  ...thread,
  id: otherId,
  workspaceId: otherWorkspace.id,
  title: "Lab notes",
  memberIds: [scout.id],
};
const otherMembers = [{ ...members[0], threadId: otherId, botId: scout.id, name: "scout" }];

function routes() {
  return fakeFetch({
    "GET /api/bots/bot_1/screen": { state: "stopped", humanHeld: false },
    "GET /api/workspaces": { workspaces: [workspace, otherWorkspace] },
    "GET /api/bots/bot_2/screen": { state: "stopped", humanHeld: false },
    "GET /api/bots": { bots: [bot, scout] },
    // #113 slice CH: the rail reads one workspace's page at a time.
    "GET /api/threads?workspaceId=ws_1&limit=50": { threads: [thread] },
    "GET /api/threads?workspaceId=ws_2&limit=50": { threads: [otherThread] },
    "GET /api/threads/thr_1": { thread, members },
    "GET /api/threads/thr_2": { thread: otherThread, members: otherMembers },
    "GET /api/workspaces/ws_1": workspaceView(),
    "GET /api/workspaces/ws_2": workspaceView({ workspace: otherWorkspace, bots: [scout] }),
    "GET /api/threads/thr_1/messages": { messages: [message(1, "human", "check the console")] },
    "GET /api/threads/thr_2/messages": { messages: [message(1, "human", "read the paper")] },
    "GET /api/runs?threadId=thr_1": { runs: [] },
    "GET /api/runs?threadId=thr_2": { runs: [] },
    "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
    "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [] },
    "GET /api/approvals?status=pending&threadId=thr_2": { approvals: [] },
    "GET /api/approvals?status=decided&threadId=thr_2": { approvals: [] },
  }).fetch;
}

/** The app shell's wiring in miniature: the switcher and the chat screen share one scope. */
function Shell({ api }: { api: ApiClient }) {
  const route = useHashRoute();
  const scope = useWorkspaceScope(api);
  return (
    <>
      <WorkspaceSwitcher scope={scope} />
      <ThreadScreen
        threadId={route.name === "threads" ? (route.id as ThreadId) : undefined}
        api={api}
      />
    </>
  );
}

function renderShell(hash: string) {
  window.location.hash = hash;
  const api = createApiClient({ fetch: routes() });
  return render(
    <WorkspaceScopeProvider api={api} initialWorkspaceId={workspace.id}>
      <Shell api={api} />
    </WorkspaceScopeProvider>,
  );
}

function chooseWorkspace(name: string) {
  fireEvent.click(screen.getByRole("button", { name: /^Workspace: / }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: new RegExp(name) }));
}

function rail(): HTMLElement {
  return document.querySelector(".thread-rail-panel") as HTMLElement;
}

describe("ThreadScreen workspace switching (#106)", () => {
  beforeEach(() => {
    localStorage.removeItem("deskmates.workspace");
    localStorage.removeItem("deskmates.showChatInfo");
    installFakeEventSource();
  });
  afterEach(() => {
    cleanup();
    window.location.hash = "";
    vi.restoreAllMocks();
  });

  it("leaves the open chat for the new workspace's chat list when the operator switches", async () => {
    renderShell("#/threads/thr_1");
    await screen.findByText("check the console");
    await waitFor(() => expect(within(rail()).getByText("Morning check")).toBeTruthy());

    chooseWorkspace("research");

    await waitFor(() => expect(window.location.hash).toBe("#/threads"));
    await waitFor(() => expect(within(rail()).getByText("Lab notes")).toBeTruthy());
    expect(within(rail()).queryByText("Morning check")).toBeNull();
    expect(screen.queryByText("check the console")).toBeNull();
    expect(screen.getByRole("button", { name: /research/ })).toBeTruthy();
    expect(localStorage.getItem("deskmates.workspace")).toBe(otherWorkspace.id);
  });

  it("follows a chat opened in another workspace into that workspace", async () => {
    renderShell("#/threads/thr_1");
    await screen.findByText("check the console");

    act(() => {
      window.location.hash = "#/threads/thr_2";
    });

    await screen.findByText("read the paper");
    await waitFor(() => expect(screen.getByRole("button", { name: /research/ })).toBeTruthy());
    await waitFor(() => expect(within(rail()).getByText("Lab notes")).toBeTruthy());
    expect(window.location.hash).toBe("#/threads/thr_2");
  });

  it("keeps the draft of the chat that was open when the workspace changes", async () => {
    renderShell("#/threads/thr_1");
    await screen.findByText("check the console");
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "unsent note" } });

    chooseWorkspace("research");
    await waitFor(() => expect(window.location.hash).toBe("#/threads"));
    expect(screen.queryByLabelText("Message")).toBeNull();

    // Opening the chat again (a link from the other workspace) brings the draft back.
    act(() => {
      window.location.hash = "#/threads/thr_1";
    });
    await screen.findByText("check the console");
    await waitFor(() => expect(screen.getByPlaceholderText("Message ops…")).toBeTruthy());
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("unsent note");
  });
});
