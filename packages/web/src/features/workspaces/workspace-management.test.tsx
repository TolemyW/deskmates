// @vitest-environment jsdom
// T0: User Settings › Workspaces (ADR-0034 decisions 4 and 1): 20 rows a page from the server
// with an honest range, search and filters reset to page one and stay in the address, and the
// full-page detail keyed by ID with Back to the same list and the weighted rename bound.

import "@testing-library/jest-dom/vitest";
import type {
  Workspace,
  WorkspaceDirectoryEntry,
  WorkspaceDirectoryQuery,
  WorkspaceId,
  WorkspaceLimitsView,
} from "@deskmates/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client.js";
import { SessionRolesProvider } from "../../state/session-roles.js";
import { WorkspaceScopeProvider, useWorkspaceScope } from "../../state/workspace-scope.js";
import { WorkspaceManagement } from "./workspace-management.js";

function entry(i: number, extra: Partial<WorkspaceDirectoryEntry> = {}): WorkspaceDirectoryEntry {
  return {
    id: `ws_${String(i).padStart(2, "0")}` as WorkspaceId,
    name: `team ${i}`,
    myRole: "owner",
    pinned: false,
    botCount: i % 3,
    activeRuns: 0,
    lastActivityAt: "2026-10-01T00:00:00.000Z",
    createdAt: "2026-10-01T00:00:00.000Z",
    openInternet: true,
    ...extra,
  };
}

function limitsView(workspaceId: string): WorkspaceLimitsView {
  const range = { min: 1, max: 300, off: true };
  return {
    workspaceId,
    settings: { turnBudget: 12 },
    switches: { requireBudgetForOff: false, volumeBreaker: false },
    effective: {
      continuationLimit: { value: 2, source: "default" },
      continuationWindowHours: { value: 24, source: "default" },
      maxTurns: { value: 80, source: "gateway" },
      relayCountMax: { value: 5, source: "default" },
      turnBudget: { value: 12, source: "workspace" },
      turnBudgetResetMinutes: { value: 60, source: "default" },
    },
    defaults: {
      continuationLimit: 2,
      continuationWindowHours: 24,
      maxTurns: 80,
      relayCountMax: 5,
      turnBudget: null,
      turnBudgetResetMinutes: 60,
    },
    ranges: {
      continuationLimit: range,
      continuationWindowHours: { ...range, off: false },
      maxTurns: range,
      relayCountMax: range,
      turnBudget: range,
      turnBudgetResetMinutes: { min: 5, max: 1440, off: false },
    },
    loopBreaker: { relayMax: 50, botMessages: 300, repeats: 3 },
    budgetBackstop: false,
  };
}

const ROWS = Array.from({ length: 45 }, (_, i) => entry(i));

function fakeApi(rows = ROWS) {
  const listWorkspaceDirectory = vi.fn(async (q: WorkspaceDirectoryQuery = {}) => {
    const matching = rows.filter(
      (row) =>
        (!q.q || row.name.includes(q.q) || row.id === q.q) &&
        (q.filter !== "pinned" || row.pinned) &&
        (q.filter === "archived" ? Boolean(row.archivedAt) : !row.archivedAt),
    );
    const offset = q.offset ?? 0;
    const limit = q.limit ?? 20;
    return {
      workspaces: matching.slice(offset, offset + limit),
      offset,
      limit,
      total: matching.length,
    };
  });
  const renameWorkspace = vi.fn(
    async (id: WorkspaceId, name: string) =>
      ({ id, name, egressAllowlist: ["*"] }) as unknown as Workspace,
  );
  const setApprovalMode = vi.fn(async (workspaceId: string, mode: string) => ({
    workspaceId,
    mode,
    enabled: mode === "automatic",
    expiryMinutes: 60,
  }));
  const api = {
    getAutoApproval: vi.fn(async (workspaceId: string) => ({
      workspaceId,
      mode: "automatic",
      enabled: true,
      expiryMinutes: 60,
    })),
    getWorkspaceLimits: vi.fn(async (workspaceId: string) => limitsView(workspaceId)),
    // The Network policy section (ADR-0034 decision 9) reads the allowlist.
    getWorkspace: vi.fn(async (id: string) => ({
      workspace: { id, name: id, egressAllowlist: ["*"] },
      bots: [],
      browserLock: null,
    })),
    listWorkspaces: vi.fn(async () => [] as Workspace[]),
    listWorkspaceDirectory,
    renameWorkspace,
    setApprovalMode,
    setWorkspacePinned: vi.fn(async () => {}),
    // The Working directories section (ADR-0036) reads on open; it stays loading here.
    getWorkspaceWorkdir: vi.fn(() => new Promise(() => {})),
    // So does the Desktop tools section (ADR-0048).
    getWorkspaceDesktopTools: vi.fn(() => new Promise(() => {})),
    getWorkspaceWebSearch: vi.fn(() => new Promise(() => {})),
  } as unknown as ApiClient;
  return { api, listWorkspaceDirectory, renameWorkspace, setApprovalMode };
}

beforeEach(() => {
  window.history.replaceState(null, "", "#/account/workspaces");
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("Workspaces list", () => {
  it("ignores a slow Enter response after leaving the directory", async () => {
    const { api } = fakeApi([entry(4)]);
    const result = await api.getWorkspace("ws_04" as WorkspaceId);
    let resolve: (value: typeof result) => void = () => {};
    vi.mocked(api.getWorkspace).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const page = render(<WorkspaceManagement api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Enter team 4" }));
    page.unmount();
    window.history.replaceState(null, "", "#/account");
    await act(async () => resolve(result));
    expect(window.location.hash).toBe("#/account");
  });
  it("authorizes Enter before changing workspace or route, and permits a retry after failure", async () => {
    const { api } = fakeApi([entry(4)]);
    const old = {
      id: "ws_old",
      name: "Previous team",
      egressAllowlist: ["*"],
    } as unknown as Workspace;
    vi.mocked(api.listWorkspaces).mockResolvedValue([old]);
    vi.mocked(api.getWorkspace).mockRejectedValueOnce(new Error("No longer authorized"));
    function Selection() {
      const scope = useWorkspaceScope(api);
      return <output aria-label="Current team">{scope.current?.name}</output>;
    }
    render(
      <WorkspaceScopeProvider api={api} initialWorkspaceId={old.id}>
        <Selection />
        <WorkspaceManagement api={api} />
      </WorkspaceScopeProvider>,
    );
    const enter = await screen.findByRole("button", { name: "Enter team 4" });
    await waitFor(() =>
      expect(screen.getByLabelText("Current team")).toHaveTextContent("Previous team"),
    );
    fireEvent.click(enter);
    expect(await screen.findByRole("alert")).toHaveTextContent("No longer authorized");
    expect(window.location.hash).toBe("#/account/workspaces");
    expect(screen.getByLabelText("Current team")).toHaveTextContent("Previous team");
    expect(screen.getByRole("link", { name: "Settings for team 4" })).toHaveAttribute(
      "href",
      "#/account/workspaces?ws=ws_04",
    );
    fireEvent.click(enter);
    await waitFor(() => expect(window.location.hash).toBe("#/threads"));
    expect(screen.getByLabelText("Current team")).toHaveTextContent("ws_04");
  });

  it("does not enter a workspace archived since the directory loaded", async () => {
    const { api } = fakeApi([entry(4)]);
    const result = await api.getWorkspace("ws_04" as WorkspaceId);
    vi.mocked(api.getWorkspace).mockResolvedValue({
      ...result,
      workspace: { ...result.workspace, archivedAt: "2026-10-22T00:00:00Z" },
    });
    render(<WorkspaceManagement api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Enter team 4" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/archived/i);
    expect(window.location.hash).toBe("#/account/workspaces");
  });
  it("shows 20 of 45 with the total, pages forward, and returns to page one on a new search", async () => {
    const { api, listWorkspaceDirectory } = fakeApi();
    render(<WorkspaceManagement api={api} />);
    expect(await screen.findByText("1–20 / 45")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /45 workspaces/ })).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(21);
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(await screen.findByText("21–40 / 45")).toBeInTheDocument();
    expect(listWorkspaceDirectory).toHaveBeenLastCalledWith({ offset: 20, limit: 20 });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search workspaces by name or ID" }), {
      target: { value: "team 4" },
    });
    expect(await screen.findByText("1–6 / 6")).toBeInTheDocument();
    expect(listWorkspaceDirectory).toHaveBeenLastCalledWith({ q: "team 4", offset: 0, limit: 20 });
    expect(window.location.hash).toBe("#/account/workspaces?q=team+4");
    const link = screen.getByRole("link", { name: "team 4" });
    expect(link).toHaveAttribute("href", "#/account/workspaces?q=team+4&ws=ws_04");
  });

  it("holds each pin request until it settles and restores the previous state on failure", async () => {
    const { api } = fakeApi([entry(1), entry(2)]);
    let rejectPin: (error: Error) => void = () => undefined;
    const setPin = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPin = reject;
        }),
    );
    api.setWorkspacePinned = setPin as ApiClient["setWorkspacePinned"];
    render(<WorkspaceManagement api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Pin team 1" }));
    const pending = screen.getByRole("button", { name: "Unpin team 1" });
    expect(pending).toBeDisabled();
    expect(screen.getByRole("button", { name: "Pin team 2" })).toBeEnabled();
    fireEvent.click(pending);
    expect(setPin).toHaveBeenCalledTimes(1);
    // A fresh directory page can arrive before the pending pin reaches the server.
    fireEvent.change(screen.getByRole("combobox", { name: "My role" }), {
      target: { value: "owner" },
    });
    await waitFor(() =>
      expect(api.listWorkspaceDirectory).toHaveBeenLastCalledWith({
        role: "owner",
        offset: 0,
        limit: 20,
      }),
    );
    await screen.findByRole("button", { name: "Pin team 2" });
    expect(screen.getByRole("button", { name: "Unpin team 1" })).toBeDisabled();
    await act(async () => rejectPin(new Error("Unavailable")));
    expect(screen.getByRole("alert")).toHaveTextContent("Unavailable");
    expect(screen.getByRole("button", { name: "Pin team 1" })).toBeEnabled();
  });

  it("filters by Pinned and says when nothing matches", async () => {
    const { api, listWorkspaceDirectory } = fakeApi();
    render(<WorkspaceManagement api={api} list={{ filter: "pinned" }} />);
    expect(
      await screen.findByText("No workspace matches this search and these filters."),
    ).toBeInTheDocument();
    expect(listWorkspaceDirectory).toHaveBeenCalledWith({ filter: "pinned", offset: 0, limit: 20 });
    expect(screen.getByRole("button", { name: "Pinned" })).toHaveAttribute("aria-pressed", "true");
  });

  it("hides running work below Admin and truncates a long legacy name with its full title", async () => {
    const long = "x".repeat(60);
    const { api } = fakeApi([entry(1, { myRole: "member", activeRuns: null, name: long })]);
    render(<WorkspaceManagement api={api} />);
    const link = await screen.findByRole("link", { name: long });
    expect(link).toHaveAttribute("title", long);
    expect(screen.getAllByText("Visible to Admins and Owners").length).toBeGreaterThan(0);
    expect(screen.getByRole("cell", { name: "Member" })).toBeInTheDocument();
  });
});

describe("Workspace detail", () => {
  it("opens by ID, links back to the same list and enforces the weighted name bound", async () => {
    const { api, renameWorkspace } = fakeApi();
    render(<WorkspaceManagement api={api} workspaceId="ws_04" list={{ q: "team" }} />);
    expect(await screen.findByRole("heading", { name: "team 4" })).toBeInTheDocument();
    expect(screen.getByText("ws_04")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Back to workspace list/ })).toHaveAttribute(
      "href",
      "#/account/workspaces?q=team",
    );
    fireEvent.click(screen.getByRole("button", { name: "Change name" }));
    const field = screen.getByRole("textbox", { name: /Rename/ });
    fireEvent.change(field, { target: { value: "Unsaved team name" } });
    screen.getByRole("tab", { name: "Basic" }).focus();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Basic" }), { key: "End" });
    expect(screen.getByRole("tab", { name: "Lifecycle" })).toHaveFocus();
    expect(screen.queryByRole("textbox", { name: /Rename/ })).toBeNull();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Lifecycle" }), { key: "Home" });
    expect(screen.getByRole("tab", { name: "Basic" })).toHaveFocus();
    expect(screen.getByRole("textbox", { name: /Rename/ })).toBe(field);
    expect(field).toHaveValue("Unsaved team name");
    expect(renameWorkspace).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: "研".repeat(17) } });
    expect(screen.getByText("34/32")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Too long: 34 of 32 units.");
    expect(screen.getByRole("button", { name: "Save name" })).toBeDisabled();
    fireEvent.change(field, { target: { value: "研".repeat(16) } });
    expect(screen.getByText("32/32")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(renameWorkspace).toHaveBeenCalledWith("ws_04", "研".repeat(16)));
    expect(await screen.findByText("Name saved.")).toBeInTheDocument();
  });

  it("retries an archived directory failure without claiming the workspace is missing", async () => {
    const archived = entry(4, { archivedAt: "2026-10-20T00:00:00.000Z" });
    const { api, listWorkspaceDirectory } = fakeApi([archived]);
    listWorkspaceDirectory
      .mockResolvedValueOnce({ workspaces: [], total: 0, offset: 0, limit: 1 })
      .mockRejectedValueOnce(new Error("Directory unavailable"));
    render(<WorkspaceManagement api={api} workspaceId="ws_04" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Directory unavailable");
    expect(screen.queryByText(/This workspace does not exist/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "team 4" })).toBeInTheDocument();
    expect(listWorkspaceDirectory).toHaveBeenLastCalledWith({
      q: "ws_04",
      filter: "archived",
      limit: 1,
    });
  });

  it("says a workspace the caller cannot see is not found", async () => {
    const { api } = fakeApi();
    render(<WorkspaceManagement api={api} workspaceId="ws_missing" />);
    expect(
      await screen.findByText("This workspace does not exist, or you no longer have access to it."),
    ).toBeInTheDocument();
  });

  it("holds the approval mode and the execution limits, editable by an Admin", async () => {
    const { api, setApprovalMode } = fakeApi();
    render(
      <SessionRolesProvider
        roles={{
          tenantRole: "member",
          platformMaintainer: false,
          workspaceRoles: { ws_04: "admin" },
        }}
      >
        <WorkspaceManagement api={api} workspaceId="ws_04" />
      </SessionRolesProvider>,
    );
    fireEvent.click(await screen.findByRole("tab", { name: "Team & approvals" }));
    expect(await screen.findByRole("heading", { name: "Approvals" })).toBeInTheDocument();
    const automatic = await screen.findByRole("radio", { name: /Automatic review/ });
    await waitFor(() => expect(automatic).toBeChecked());
    await waitFor(() => expect(automatic).toBeEnabled());
    fireEvent.click(screen.getByRole("radio", { name: /Approve all/ }));
    await waitFor(() => expect(setApprovalMode).toHaveBeenCalledWith("ws_04", "approve_all"));
    // ADR-0002 amendment 6, D1: the header and the section both mark approve all.
    await waitFor(() =>
      expect(screen.getAllByTestId("approve-all-badge").length).toBeGreaterThan(0),
    );
    fireEvent.click(screen.getByRole("tab", { name: "Tools & network" }));
    expect(await screen.findByRole("button", { name: "Edit limits" })).toBeInTheDocument();
  });

  it("shows both read-only to a Member of that workspace", async () => {
    const { api, setApprovalMode } = fakeApi([entry(4, { myRole: "member" })]);
    render(
      <SessionRolesProvider
        roles={{
          tenantRole: "member",
          platformMaintainer: false,
          workspaceRoles: { ws_04: "member" },
        }}
      >
        <WorkspaceManagement api={api} workspaceId="ws_04" />
      </SessionRolesProvider>,
    );
    fireEvent.click(await screen.findByRole("tab", { name: "Team & approvals" }));
    const automatic = await screen.findByRole("radio", { name: /Automatic review/ });
    await waitFor(() => expect(automatic).toBeChecked());
    expect(automatic).toBeDisabled();
    fireEvent.click(screen.getByRole("tab", { name: "Tools & network" }));
    expect(await screen.findByText(/^12 · /)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit limits" })).toBeNull();
    expect(setApprovalMode).not.toHaveBeenCalled();
  });
});
