// @vitest-environment jsdom
// T0, ADR-0022 amendment 6 W9: people are managed per workspace. Every People call names the
// selected workspace: a query parameter on the lists, the body of every write. Invitations and
// created accounts carry a role other than Owner, Guest included.
import "@testing-library/jest-dom/vitest";
import type {
  InvitationView,
  SessionRoles,
  TenantMemberView,
  Workspace,
  WorkspaceId,
} from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client.js";
import type { MembersClient, MembersPageRequest } from "../../api/members-client.js";
import { SessionRolesProvider } from "../../state/session-roles.js";
import { WorkspaceScopeProvider } from "../../state/workspace-scope.js";
import { selectOption } from "../../test-support/select.js";
import { MembersScreen } from "./members.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

const WORKSPACES = [
  { id: "ws_a", name: "Alpha", status: "ready", egressAllowlist: [] },
  { id: "ws_b", name: "Beta", status: "ready", egressAllowlist: [] },
] as unknown as Workspace[];

const PEOPLE: TenantMemberView[] = [
  { userId: "usr_1", displayName: "Olive", loginName: "olive", role: "owner", status: "active" },
  { userId: "usr_2", displayName: "Mia", loginName: "mia", role: "member", status: "active" },
];

const INVITATION: InvitationView = {
  id: "inv_1",
  role: "guest",
  workspaceId: "ws_b",
  target: { kind: "local_signup" },
  createdBy: "user:usr_1",
  createdAt: "2026-10-13T00:00:00.000Z",
  expiresAt: "2026-10-20T00:00:00.000Z",
  status: "open",
};

function membersClient() {
  return {
    listMembers: vi.fn(async (_workspaceId?: string) => PEOPLE),
    pageMembers: vi.fn(async (_workspaceId: string | undefined, _page: MembersPageRequest) => ({
      members: PEOPLE,
      offset: 0,
      limit: 25,
      total: PEOPLE.length,
    })),
    pageInvitations: vi.fn(async (_workspaceId: string | undefined, _page: unknown) => ({
      invitations: [INVITATION],
      offset: 0,
      limit: 25,
      total: 1,
    })),
    updateMember: vi.fn(async () => {}),
    revokeInvitation: vi.fn(async () => {}),
    createInvitation: vi.fn(async (input: { role: InvitationView["role"] }) => ({
      invitation: { ...INVITATION, id: "inv_2", role: input.role },
      link: "/#/invite/secret-token",
    })),
    createAccount: vi.fn(async (input: { loginName: string; role: InvitationView["role"] }) => ({
      member: {
        userId: "usr_9",
        displayName: input.loginName,
        loginName: input.loginName,
        role: input.role,
        status: "active" as const,
      },
      loginName: input.loginName,
      initialPassword: "Demo-Only-Password",
    })),
    updatePreferences: vi.fn(async () => ({})),
  };
}

it("sends the selected workspace on every People call", async () => {
  const client = membersClient();
  const api = { listWorkspaces: vi.fn(async () => WORKSPACES) } as unknown as ApiClient;
  const roles: SessionRoles = {
    tenantRole: "owner",
    platformMaintainer: false,
    workspaceRoles: { ws_a: "member", ws_b: "owner" },
  };
  render(
    <SessionRolesProvider roles={roles}>
      <WorkspaceScopeProvider api={api} initialWorkspaceId={"ws_b" as WorkspaceId}>
        <MembersScreen
          client={client as unknown as MembersClient}
          tenantRole="owner"
          tenantName="Tenant"
          userId="usr_1"
          ssoProviders={[]}
        />
      </WorkspaceScopeProvider>
    </SessionRolesProvider>,
  );
  await screen.findByText("Mia");
  await waitFor(() =>
    expect(client.pageMembers).toHaveBeenLastCalledWith("ws_b", { offset: 0, limit: 25 }),
  );
  expect(client.pageInvitations).toHaveBeenLastCalledWith("ws_b", { offset: 0, limit: 25 });
  expect(screen.getByTestId("members-workspace")).toHaveTextContent("Roles in Beta");
  // Lists named only the selected workspace, never none.
  for (const call of [...client.pageMembers.mock.calls, ...client.pageInvitations.mock.calls])
    expect(call[0]).toBe("ws_b");

  // A role change, Guest included, and a removal.
  await selectOption(screen.getByLabelText("Role of Mia"), "Guest");
  await waitFor(() =>
    expect(client.updateMember).toHaveBeenCalledWith("usr_2", {
      role: "guest",
      workspaceId: "ws_b",
    }),
  );
  const mia = screen.getAllByRole("row").find((row) => row.textContent?.includes("Mia"));
  fireEvent.click(within(mia as HTMLElement).getByRole("button", { name: "Remove" }));
  await waitFor(() =>
    expect(client.updateMember).toHaveBeenCalledWith("usr_2", {
      status: "removed",
      workspaceId: "ws_b",
    }),
  );

  // Revoking an invitation.
  fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
  await waitFor(() => expect(client.revokeInvitation).toHaveBeenCalledWith("inv_1", "ws_b"));

  // An invitation as a Guest.
  fireEvent.click(screen.getByRole("button", { name: "Invite by link" }));
  await selectOption(await screen.findByLabelText("Role"), "Guest");
  fireEvent.click(screen.getByRole("button", { name: "Create invitation link" }));
  await waitFor(() =>
    expect(client.createInvitation).toHaveBeenCalledWith({
      role: "guest",
      target: { kind: "local_signup" },
      workspaceId: "ws_b",
    }),
  );

  // A created account.
  fireEvent.click(await screen.findByRole("button", { name: "Create account" }));
  fireEvent.change(await screen.findByLabelText("Username"), { target: { value: "max" } });
  fireEvent.submit(screen.getByRole("form", { name: "Create account" }));
  await waitFor(() =>
    expect(client.createAccount).toHaveBeenCalledWith({
      loginName: "max",
      role: "member",
      workspaceId: "ws_b",
    }),
  );
});

it("offers Owner only to an Owner of the workspace, and Guest to an Admin", async () => {
  const client = membersClient();
  render(
    <SessionRolesProvider roles={{ tenantRole: "admin", platformMaintainer: false }}>
      <MembersScreen
        client={client as unknown as MembersClient}
        tenantRole="admin"
        userId="usr_1"
        ssoProviders={[]}
        workspaceId="ws_b"
      />
    </SessionRolesProvider>,
  );
  fireEvent.click(await screen.findByLabelText("Role of Mia"));
  expect(await screen.findByRole("option", { name: "Guest" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "Admin" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "Owner" })).toBeNull();
});

it("pages people 25 at a time with their total, and a role filter returns to the first page (#113 slice M)", async () => {
  const many: TenantMemberView[] = Array.from({ length: 30 }, (_, i) => ({
    userId: `usr_${String(i).padStart(2, "0")}`,
    displayName: `Person ${String(i).padStart(2, "0")}`,
    loginName: `p${i}`,
    role: i % 3 === 0 ? "guest" : "member",
    status: "active",
  }));
  const pageMembers = vi.fn(async (_workspaceId: string | undefined, page: MembersPageRequest) => {
    const rows = many.filter((m) => page.role === undefined || m.role === page.role);
    const offset = page.offset ?? 0;
    const limit = page.limit ?? 25;
    return { members: rows.slice(offset, offset + limit), offset, limit, total: rows.length };
  });
  const client = { ...membersClient(), pageMembers };
  render(
    <SessionRolesProvider roles={{ tenantRole: "owner", platformMaintainer: false }}>
      <MembersScreen
        client={client as unknown as MembersClient}
        tenantRole="owner"
        userId="usr_00"
        ssoProviders={[]}
        workspaceId="ws_b"
      />
    </SessionRolesProvider>,
  );
  await screen.findByText("Person 24");
  const pages = screen.getByRole("navigation", { name: "Member pages" });
  expect(pages).toHaveTextContent("1–25 of 30");
  fireEvent.click(within(pages).getByRole("button", { name: "Next" }));
  await screen.findByText("Person 29");
  expect(screen.queryByText("Person 00")).toBeNull();
  expect(pageMembers).toHaveBeenLastCalledWith("ws_b", { offset: 25, limit: 25 });
  // A filter is a new scope: back to the first page, asking for that role only.
  await selectOption(screen.getByLabelText("Show role"), "Guest");
  await waitFor(() =>
    expect(pageMembers).toHaveBeenLastCalledWith("ws_b", { offset: 0, limit: 25, role: "guest" }),
  );
  await screen.findByText("Person 00");
  expect(screen.getByRole("navigation", { name: "Member pages" })).toHaveTextContent("1–10 of 10");
});
