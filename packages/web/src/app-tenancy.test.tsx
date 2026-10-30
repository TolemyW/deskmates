import { selectOption } from "./test-support/select.js";
// @vitest-environment jsdom
// ADR-0022 P4 in the browser: the tenant switcher, SSO sign-in and step-up, invitation
// acceptance and the People screen. Every request names the tab's tenant; switching tenant
// remounts the screens so a late answer for the previous tenant is never shown.
import "@testing-library/jest-dom/vitest";
import type { TenantMemberView } from "@deskmates/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MembersClient } from "./api/members-client.js";
import { App } from "./app.js";
import { MembersScreen } from "./features/members/members.js";
import { FakeEventSource, installFakeEventSource, workspace } from "./test-support/fixtures.js";

beforeEach(() => {
  window.location.hash = "#/threads";
  installFakeEventSource();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
  // The workspace a test selected is remembered in this browser; each test starts without it.
  window.localStorage.clear();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const TENANTS = {
  tnt_a: { id: "tnt_a", name: "Alpha", role: "owner" as const },
  tnt_b: { id: "tnt_b", name: "Beta", role: "member" as const },
  tnt_c: { id: "tnt_c", name: "Gamma", role: "member" as const },
};

function sessionView(tenantId: keyof typeof TENANTS) {
  return {
    authenticated: true,
    user: { id: "usr_1", displayName: "Olive", loginName: "olive" },
    tenant: TENANTS[tenantId],
    session: {
      authenticatedAt: "2026-10-05T00:00:00.000Z",
      idleExpiresAt: "2026-10-12T00:00:00.000Z",
      absoluteExpiresAt: "2026-11-04T00:00:00.000Z",
    },
    csrfToken: `csrf-${tenantId}`,
    tenants: [
      { ...TENANTS.tnt_a, enterable: true, ssoProviders: [] },
      { ...TENANTS.tnt_b, enterable: true, ssoProviders: [] },
      {
        ...TENANTS.tnt_c,
        enterable: false,
        ssoProviders: [{ id: "corp", displayName: "Corp SSO" }],
      },
    ],
  };
}

// The organization switcher was removed with the owner's decision of 2026-10-10 (multi-tenancy
// is not a product feature); a session still names its tenant on every request.
it("names the tenant on every request and offers no organization switcher", async () => {
  const seen: Array<{ path: string; tenant: string | null }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const tenant = new Headers(init?.headers).get("x-deskmates-tenant");
      seen.push({ path, tenant });
      if (path === "/auth/session") return json(sessionView("tnt_a"));
      if (path.startsWith("/api/workspaces"))
        return json({ workspaces: [{ ...workspace, id: "ws_a", name: "Alpha workspace" }] });
      if (path === "/api/config")
        return json({ defaultModel: "m", cheapModel: "c", release: null });
      return json({ bots: [], threads: [], approvals: [], workspaces: [] });
    }),
  );
  render(<App />);
  await screen.findByText("Alpha workspace");
  expect(screen.queryByRole("button", { name: "Switch organization" })).not.toBeInTheDocument();
  const apiCalls = seen.filter((call) => call.path.startsWith("/api/"));
  expect(apiCalls.length).toBeGreaterThan(0);
  expect(apiCalls.every((call) => call.tenant === "tnt_a")).toBe(true);
  expect(FakeEventSource.instances.some((es) => es.url.includes("tenant=tnt_a"))).toBe(true);
});

it("shows SSO providers on the sign-in screen and explains a refused SSO sign-in", async () => {
  window.history.replaceState(null, "", "/?sso_error=no_account");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/auth/session")
        return json({
          authenticated: false,
          setupRequired: false,
          loginCsrf: "login-csrf",
          ssoProviders: [{ id: "corp", displayName: "Corp SSO" }],
        });
      return json({}, 404);
    }),
  );
  render(<App />);
  expect(await screen.findByRole("button", { name: "Sign in with Corp SSO" })).toBeEnabled();
  expect(screen.getByRole("alert")).toHaveTextContent(/No account is linked/);
  // The error code is removed from the address bar once read.
  expect(window.location.search).toBe("");
});

it("accepts a new-account invitation and signs in to the invited team", async () => {
  window.location.hash = "#/invite/tok_123";
  const accepted: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/auth/session")
        return json({ authenticated: false, setupRequired: false, loginCsrf: "login-csrf" });
      if (path === "/auth/invitations/tok_123")
        return json({
          tenantName: "Beta",
          role: "member",
          target: { kind: "local_new", loginName: "newbie" },
        });
      if (path === "/auth/invitations/accept") {
        accepted.push({
          body: JSON.parse(String(init?.body)),
          csrf: new Headers(init?.headers).get("x-deskmates-csrf"),
        });
        return json(sessionView("tnt_b"));
      }
      if (path === "/api/config")
        return json({ defaultModel: "m", cheapModel: "c", release: null });
      return json({ bots: [], threads: [], approvals: [], workspaces: [] });
    }),
  );
  render(<App />);
  expect(await screen.findByRole("heading", { name: "Join Beta" })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "a long password here" },
  });
  fireEvent.change(screen.getByLabelText("Confirm new password"), {
    target: { value: "a long password here" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create account and join" }));
  await screen.findByText("member · Beta");
  expect(accepted).toEqual([
    {
      body: { token: "tok_123", password: "a long password here" },
      csrf: "login-csrf",
    },
  ]);
  expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
});

it("explains an unusable invitation without saying why", async () => {
  window.location.hash = "#/invite/bad";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) =>
      String(input) === "/auth/session"
        ? json({ authenticated: false, setupRequired: false, loginCsrf: "x" })
        : json({ code: "token_rejected", message: "no" }, 401),
    ),
  );
  render(<App />);
  expect(await screen.findByRole("alert")).toHaveTextContent(/not valid/);
});

function membersClient(members: TenantMemberView[]) {
  const client: MembersClient = {
    listMembers: vi.fn(async () => members),
    updateMember: vi.fn(async () => {}),
    pageMembers: vi.fn(async () => ({ members, offset: 0, limit: 25, total: members.length })),
    pageInvitations: vi.fn(async () => ({ invitations: [], offset: 0, limit: 25, total: 0 })),
    createInvitation: vi.fn(async (input) => ({
      invitation: {
        id: "inv_1",
        role: input.role,
        target: input.target,
        createdBy: "user:usr_1",
        createdAt: "2026-10-05T00:00:00.000Z",
        expiresAt: "2026-10-12T00:00:00.000Z",
        status: "open" as const,
      },
      link: "/#/invite/secret-token",
    })),
    revokeInvitation: vi.fn(async () => {}),
    createAccount: vi.fn(async (input) => ({
      member: {
        userId: "usr_9",
        displayName: input.displayName,
        loginName: input.loginName,
        role: input.role,
        status: "active" as const,
      },
      loginName: input.loginName,
      initialPassword: "Abcd-Efgh-Jkmn-Pqrs-Tuvw",
    })),
    updatePreferences: vi.fn(async () => ({})),
  };
  return client;
}

const PEOPLE: TenantMemberView[] = [
  { userId: "usr_1", displayName: "Olive", loginName: "olive", role: "admin", status: "active" },
  { userId: "usr_2", displayName: "Owen", loginName: "owen", role: "owner", status: "active" },
  { userId: "usr_3", displayName: "Mia", loginName: "mia", role: "member", status: "active" },
];

it("offers an Admin only the actions the Gateway allows an Admin", async () => {
  const client = membersClient(PEOPLE);
  render(<MembersScreen client={client} tenantRole="admin" userId="usr_1" ssoProviders={[]} />);
  await screen.findByText("Mia");
  // An Admin changes Members and Guests only (ADR-0022 amendment 6 W4): a role select and Remove
  // on Mia, Leave on self, nothing on the Owner.
  expect(screen.getByLabelText("Role of Mia")).toBeInTheDocument();
  expect(screen.queryByLabelText("Role of Owen")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Role of Olive")).not.toBeInTheDocument();
  const rows = screen.getAllByRole("row");
  const owen = rows.find((row) => row.textContent?.includes("Owen"));
  expect(owen?.textContent).not.toMatch(/Remove/);
  expect(screen.getByRole("button", { name: "Leave" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
  // Two named entry points; no form until one is chosen, and no inviter-chosen login name.
  expect(screen.queryByRole("button", { name: "Create invitation link" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Invite by link" }));
  expect(screen.queryByLabelText("Login name")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Create invitation link" }));
  expect(await screen.findByRole("heading", { name: "Invitation link ready" })).toBeInTheDocument();
  expect(screen.getByText(/\/#\/invite\/secret-token/)).toBeInTheDocument();
  expect(client.createInvitation).toHaveBeenCalledWith({
    role: "member",
    target: { kind: "local_signup" },
  });
});

it("lets an Owner change roles and shows the Gateway's refusal", async () => {
  const client = membersClient(PEOPLE);
  vi.mocked(client.updateMember).mockRejectedValueOnce(
    new Error("the last Owner of a tenant cannot be demoted or removed"),
  );
  render(<MembersScreen client={client} tenantRole="owner" userId="usr_2" ssoProviders={[]} />);
  await selectOption(await screen.findByLabelText("Role of Owen"), "Member");
  expect(await screen.findByRole("alert")).toHaveTextContent(/last Owner/);
  expect(client.updateMember).toHaveBeenCalledWith("usr_2", { role: "member" });
});

it("distinguishes member load failure from an empty list and supports retry", async () => {
  const client = membersClient([]);
  vi.mocked(client.pageMembers).mockRejectedValueOnce(new Error("Service unavailable"));
  render(<MembersScreen client={client} tenantRole="owner" userId="usr_1" ssoProviders={[]} />);
  expect(screen.getByText("Loading members…")).toBeInTheDocument();
  expect(await screen.findByRole("alert")).toHaveTextContent("Service unavailable");
  expect(screen.queryByText("No members to show.")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("No members to show.")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
