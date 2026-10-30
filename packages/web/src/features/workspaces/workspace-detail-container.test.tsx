// @vitest-environment jsdom
// T1 (in-process), issue #15: the workspace page says in words whether the container exists, and
// why not when the Gateway knows: archived, never created, removed on the host since its last
// run. `status: "ready"` alone never claims a container.

import "@testing-library/jest-dom/vitest";
import type {
  Workspace,
  WorkspaceContainerState,
  WorkspaceDirectoryEntry,
  WorkspaceDirectoryQuery,
  WorkspaceId,
} from "@deskmates/contracts";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client.js";
import { SessionRolesProvider } from "../../state/session-roles.js";
import { WorkspaceManagement } from "./workspace-management.js";

const WS = "ws_07" as WorkspaceId;

function entry(extra: Partial<WorkspaceDirectoryEntry> = {}): WorkspaceDirectoryEntry {
  return {
    id: WS,
    name: "Research",
    myRole: "admin",
    pinned: false,
    botCount: 1,
    activeRuns: 0,
    lastActivityAt: "2026-10-01T00:00:00.000Z",
    createdAt: "2026-10-01T00:00:00.000Z",
    openInternet: true,
    ...extra,
  };
}

function fakeApi(row: WorkspaceDirectoryEntry, container: WorkspaceContainerState | undefined) {
  const workspace = {
    id: WS,
    name: row.name,
    status: "ready",
    egressAllowlist: ["*"],
  } as unknown as Workspace;
  const getWorkspace = vi.fn(async () => ({
    workspace,
    bots: [],
    browserLock: null,
    takeoverScreen: false,
    ...(container ? { container } : {}),
  }));
  const api = {
    getAutoApproval: vi.fn(async (workspaceId: string) => ({ workspaceId, enabled: false })),
    getWorkspace,
    getWorkspaceDesktopTools: vi.fn(() => new Promise(() => {})),
    getWorkspaceWebSearch: vi.fn(() => new Promise(() => {})),
    getWorkspaceLimits: vi.fn(() => new Promise(() => {})),
    getWorkspaceWorkdir: vi.fn(() => new Promise(() => {})),
    listWorkspaceDirectory: vi.fn(async (q: WorkspaceDirectoryQuery = {}) => {
      const visible = (q.filter === "archived") === Boolean(row.archivedAt) ? [row] : [];
      return { workspaces: visible, offset: 0, limit: 20, total: visible.length };
    }),
    listWorkspaces: vi.fn(async () => [] as Workspace[]),
    setWorkspacePinned: vi.fn(async () => {}),
  } as unknown as ApiClient;
  return { api, getWorkspace };
}

function renderDetail(api: ApiClient) {
  return render(
    <SessionRolesProvider
      roles={{ tenantRole: "admin", platformMaintainer: false, workspaceRoles: { [WS]: "admin" } }}
    >
      <WorkspaceManagement api={api} workspaceId={WS} />
    </SessionRolesProvider>,
  );
}

async function containerLine(): Promise<string> {
  await screen.findByRole("heading", { name: "Research" });
  const line = await screen.findByTestId("workspace-container");
  await waitFor(() => expect(line.textContent).not.toMatch(/Checking/));
  expect(within(line).getByText("Container")).toBeInTheDocument();
  return line.querySelector("dd")?.textContent ?? "";
}

beforeEach(() => {
  window.history.replaceState(null, "", `#/account/workspaces?ws=${WS}`);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("workspace detail: the Container line (#15)", () => {
  it("says a never-created container is absent and what the first message does", async () => {
    renderDetail(fakeApi(entry(), "never_created").api);
    expect(await containerLine()).toBe(
      "Absent: never created. The first message in one of its chats creates it.",
    );
  });

  it("says a container removed on the host is absent and the next message recreates it", async () => {
    renderDetail(fakeApi(entry(), "removed").api);
    expect(await containerLine()).toMatch(
      /^Absent: removed on the host since its last run\. The next message .* recreates it\.$/,
    );
  });

  it("says an archived workspace's container is absent and its messages are refused", async () => {
    // The Gateway does not serve an archived workspace's detail: `archivedAt` alone says it.
    renderDetail(fakeApi(entry({ archivedAt: "2026-10-14T00:00:00.000Z" }), "present").api);
    expect(await containerLine()).toMatch(
      /^Absent: archived\. .* is refused until it is restored\.$/,
    );
  });

  it("says a present container is present, and shows no line for an older Gateway", async () => {
    renderDetail(fakeApi(entry(), "present").api);
    expect(await containerLine()).toBe("Present on the sandbox host.");
    cleanup();

    const older = fakeApi(entry(), undefined);
    renderDetail(older.api);
    await screen.findByRole("heading", { name: "Research" });
    await waitFor(() => expect(older.getWorkspace).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId("workspace-container")).toBeNull());
  });
});
