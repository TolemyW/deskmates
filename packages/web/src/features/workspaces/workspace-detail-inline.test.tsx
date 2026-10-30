// @vitest-environment jsdom
// T0: ADR-0034 decision 9. The workspace detail page edits its network policy, people and archive
// state in place through the existing routes, for the roles those routes accept, and never
// changes the selected workspace to do so.

import "@testing-library/jest-dom/vitest";
import type {
  AuthenticatedSessionView,
  TenantMemberView,
  TenantRole,
  Workspace,
  WorkspaceDirectoryEntry,
  WorkspaceDirectoryQuery,
  WorkspaceId,
} from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client.js";
import type { MembersClient } from "../../api/members-client.js";
import { SessionRolesProvider } from "../../state/session-roles.js";
import { NetworkSection } from "./detail/network-section.js";
import { WorkspaceManagement } from "./workspace-management.js";

const WS = "ws_07" as WorkspaceId;

function directoryEntry(extra: Partial<WorkspaceDirectoryEntry> = {}): WorkspaceDirectoryEntry {
  return {
    id: WS,
    name: "Research",
    myRole: "admin",
    pinned: false,
    botCount: 1,
    activeRuns: 0,
    lastActivityAt: "2026-10-01T00:00:00.000Z",
    createdAt: "2026-10-01T00:00:00.000Z",
    openInternet: false,
    ...extra,
  };
}

function fakeApi(row: WorkspaceDirectoryEntry, allowlist: string[]) {
  let stored = { id: WS, name: row.name, egressAllowlist: allowlist } as unknown as Workspace;
  const listWorkspaceDirectory = vi.fn(async (q: WorkspaceDirectoryQuery = {}) => {
    const visible = (q.filter === "archived") === Boolean(row.archivedAt) ? [row] : [];
    return { workspaces: visible, offset: 0, limit: 20, total: visible.length };
  });
  const updateWorkspaceEgress = vi.fn(async (_id: WorkspaceId, egressAllowlist: string[]) => {
    stored = { ...stored, egressAllowlist } as Workspace;
    return stored;
  });
  const archiveWorkspace = vi.fn(
    async () => ({ ...stored, archivedAt: "2026-10-14T00:00:00.000Z" }) as Workspace,
  );
  const restoreWorkspace = vi.fn(async () => stored);
  const api = {
    archiveWorkspace,
    getAutoApproval: vi.fn(async (workspaceId: string) => ({ workspaceId, enabled: false })),
    getWorkspace: vi.fn(async () => ({ workspace: stored, bots: [], browserLock: null })),
    getWorkspaceDesktopTools: vi.fn(() => new Promise(() => {})),
    getWorkspaceWebSearch: vi.fn(() => new Promise(() => {})),
    getWorkspaceLimits: vi.fn(() => new Promise(() => {})),
    getWorkspaceWorkdir: vi.fn(() => new Promise(() => {})),
    listWorkspaceDirectory,
    listWorkspaces: vi.fn(async () => [] as Workspace[]),
    restoreWorkspace,
    setWorkspacePinned: vi.fn(async () => {}),
    updateWorkspaceEgress,
  } as unknown as ApiClient;
  return { api, updateWorkspaceEgress, archiveWorkspace, restoreWorkspace };
}

const PEOPLE: TenantMemberView[] = [
  { userId: "usr_1", displayName: "Olive", loginName: "olive", role: "owner", status: "active" },
  { userId: "usr_2", displayName: "Mia", loginName: "mia", role: "member", status: "active" },
];

function shell() {
  const members = {
    pageMembers: vi.fn(async () => ({ members: PEOPLE, offset: 0, limit: 25, total: 2 })),
    pageInvitations: vi.fn(async () => ({ invitations: [], offset: 0, limit: 25, total: 0 })),
    updateMember: vi.fn(async () => {}),
    revokeInvitation: vi.fn(async () => {}),
    createInvitation: vi.fn(),
    createAccount: vi.fn(),
  } as unknown as MembersClient;
  const session = {
    tenant: { id: "ten_1", name: "Team", role: "admin" },
    user: { id: "usr_9" },
    tenants: [],
  } as unknown as AuthenticatedSessionView;
  return { members, session };
}

function renderAs(role: TenantRole, api: ApiClient, people = shell()) {
  return render(
    <SessionRolesProvider
      roles={{ tenantRole: role, platformMaintainer: false, workspaceRoles: { [WS]: role } }}
    >
      <WorkspaceManagement api={api} workspaceId={WS} shell={people} />
    </SessionRolesProvider>,
  );
}

const section = (name: string) => {
  const group =
    name === "Network policy"
      ? "Tools & network"
      : name === "People"
        ? "Team & approvals"
        : "Lifecycle";
  fireEvent.click(screen.getByRole("tab", { name: group }));
  return screen.getByRole("heading", { name }).closest("section") as HTMLElement;
};

beforeEach(() => {
  window.history.replaceState(null, "", `#/account/workspaces?ws=${WS}`);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("workspace detail: network policy in place", () => {
  it("an Admin edits the allowlist, confirms a removal and saves through PATCH", async () => {
    const { api, updateWorkspaceEgress } = fakeApi(directoryEntry(), ["a.example", "b.example"]);
    renderAs("admin", api);
    await screen.findByRole("heading", { name: "Research" });
    const network = section("Network policy");
    const box = await within(network).findByRole("textbox");
    expect(box).toHaveValue("a.example\nb.example");
    fireEvent.change(box, { target: { value: "a.example\nc.example" } });
    fireEvent.click(within(network).getByRole("button", { name: "Save network policy" }));
    // Removing b.example asks first and writes nothing yet.
    expect(within(network).getByText(/no longer reach b\.example/)).toBeInTheDocument();
    expect(updateWorkspaceEgress).not.toHaveBeenCalled();
    fireEvent.click(within(network).getByRole("button", { name: "Save and remove" }));
    await waitFor(() =>
      expect(updateWorkspaceEgress).toHaveBeenCalledWith(WS, ["a.example", "c.example"]),
    );
    expect(await within(network).findByText("Network policy saved.")).toBeInTheDocument();

    // Switching to the open internet is one save, with no removal question for "*".
    fireEvent.click(within(network).getByRole("radio", { name: /Open/ }));
    fireEvent.click(within(network).getByRole("button", { name: "Save network policy" }));
    expect(within(network).getByText(/no longer reach a\.example, c\.example/)).toBeInTheDocument();
    fireEvent.click(within(network).getByRole("button", { name: "Save and remove" }));
    await waitFor(() => expect(updateWorkspaceEgress).toHaveBeenLastCalledWith(WS, ["*"]));
  });

  it("a Member reads the mode and the list and gets no editor", async () => {
    const { api, updateWorkspaceEgress } = fakeApi(directoryEntry({ myRole: "member" }), [
      "a.example",
    ]);
    renderAs("member", api);
    await screen.findByRole("heading", { name: "Research" });
    const network = section("Network policy");
    expect(await within(network).findByText("a.example")).toBeInTheDocument();
    expect(within(network).queryByRole("textbox")).toBeNull();
    expect(within(network).getByText(/An Admin or Owner of this workspace changes/)).toBeTruthy();
    expect(updateWorkspaceEgress).not.toHaveBeenCalled();
  });
});

describe("workspace detail: people in place", () => {
  it("an Admin sees this workspace's people with role controls and the invite form", async () => {
    const { api } = fakeApi(directoryEntry(), []);
    const people = shell();
    renderAs("admin", api, people);
    await screen.findByRole("heading", { name: "Research" });
    const block = section("People");
    expect(await within(block).findByText("Mia")).toBeInTheDocument();
    expect(people.members.pageMembers).toHaveBeenCalledWith(WS, expect.anything());
    expect(within(block).queryByRole("heading", { level: 1 })).toBeNull();
    expect(within(block).getByLabelText("Role of Mia")).toBeInTheDocument();
  });

  it("a Member gets a note instead of the list", async () => {
    const { api } = fakeApi(directoryEntry({ myRole: "member" }), []);
    const people = shell();
    renderAs("member", api, people);
    await screen.findByRole("heading", { name: "Research" });
    expect(
      within(section("People")).getByText(/managed by this workspace's Admins and Owners/),
    ).toBeInTheDocument();
    expect(people.members.pageMembers).not.toHaveBeenCalled();
  });
});

describe("workspace detail: archive in place", () => {
  it("an Admin archives after the confirmation, then restores in place", async () => {
    const { api, archiveWorkspace, restoreWorkspace } = fakeApi(directoryEntry(), []);
    renderAs("admin", api);
    await screen.findByRole("heading", { name: "Research" });
    fireEvent.click(
      within(section("Archive")).getByRole("button", { name: "Move workspace to Trash" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(archiveWorkspace).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Move to Trash" }));
    await waitFor(() => expect(archiveWorkspace).toHaveBeenCalledWith(WS));
    expect(await screen.findByText(/Moved to Trash/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restore workspace" }));
    await waitFor(() => expect(restoreWorkspace).toHaveBeenCalledWith(WS));
    expect(await screen.findByText(/Restored\. The workspace is active again/)).toBeTruthy();
  });

  it("a Member gets no archive control", async () => {
    const { api } = fakeApi(directoryEntry({ myRole: "member" }), []);
    renderAs("member", api);
    await screen.findByRole("heading", { name: "Research" });
    expect(screen.queryByRole("heading", { name: "Archive" })).toBeNull();
  });
});

it("retries a failed network read locally without submitting a policy change", async () => {
  const row = directoryEntry();
  const { api, updateWorkspaceEgress } = fakeApi(row, ["example.test"]);
  vi.mocked(api.getWorkspace).mockRejectedValueOnce(new Error("Network unavailable"));
  render(<NetworkSection api={api} entry={row} onChanged={vi.fn()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Network unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("example.test")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(updateWorkspaceEgress).not.toHaveBeenCalled();
});
