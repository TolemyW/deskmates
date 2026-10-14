// @vitest-environment jsdom
// T0, issue #14 item 4: each screen hides or disables what the session's role cannot take and
// says which role can, for Member, Admin and platform-maintainer sessions. The Gateway still
// decides; these tests prove only that the UI does not offer what it would refuse.
import "@testing-library/jest-dom/vitest";
import type { SessionRoles, TenantMemberView } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "./api/client.js";
import type { MembersClient } from "./api/members-client.js";
import { App } from "./app.js";
import { BotEditor, EgressEditor, ManagementScreen } from "./features/contacts/management.js";
import { CostAlertsPanel } from "./features/costs/cost-alerts.js";
import { IntegrationsScreen } from "./features/integrations/integrations.js";
import { KnowledgePanel } from "./features/knowledge/knowledge.js";
import { MembersScreen } from "./features/members/members.js";
import { SessionRolesProvider } from "./state/session-roles.js";
import { approvalRule, bot, installFakeEventSource, workspace } from "./test-support/fixtures.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const MEMBER: SessionRoles = { tenantRole: "member", platformMaintainer: false };
const ADMIN: SessionRoles = { tenantRole: "admin", platformMaintainer: false };
const OWNER: SessionRoles = { tenantRole: "owner", platformMaintainer: false };
/** Platform maintenance is separate from the tenant role: a Member may hold it. */
const MAINTAINER: SessionRoles = { tenantRole: "member", platformMaintainer: true };
/** The line `RoleNote` renders: "Only <who> can <do something>." */
const ROLE_NOTE = /^Only .+ can .+\.$/;

function as(roles: SessionRoles, ui: ReactNode) {
  return render(<SessionRolesProvider roles={roles}>{ui}</SessionRolesProvider>);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A Gateway that answers every read the screens below make. */
function gatewayFetch(path: string): Response {
  if (path === "/api/integrations")
    return json({
      configured: true,
      oauthAvailable: true,
      providers: [
        { service: "slack", displayName: "Slack", authKinds: ["api_key"], adoptedAt: "x" },
      ],
    });
  if (path === "/api/integrations/catalog")
    return json({
      configured: true,
      complete: true,
      providers: [
        { service: "slack", displayName: "Slack", authKinds: ["api_key"], adopted: true },
        { service: "github", displayName: "GitHub", authKinds: ["oauth"], adopted: false },
      ],
    });
  if (path === "/api/workspaces") return json({ workspaces: [workspace] });
  if (path.includes("/connections?"))
    return json({
      offset: 0,
      limit: 25,
      total: 1,
      liveByService: [{ service: "slack", count: 1 }],
      connections: [
        {
          id: "icn_1",
          workspaceId: workspace.id,
          service: "slack",
          connectionName: "team",
          runtimeConnectionId: "rt",
          authKind: "api_key",
          createdAt: "2026-10-09T00:00:00.000Z",
        },
      ],
    });
  if (path.startsWith("/api/connectors"))
    return json({ connectors: [], offset: 0, limit: 25, total: 0 });
  if (path === "/api/config")
    return json({ defaultModel: "m", cheapModel: "c", cronTimeZone: "UTC", release: null });
  if (path.startsWith("/api/bots/bot_1/soul"))
    return json({ soul: { body: "Be kind.", version: "v1" } });
  if (path.startsWith("/api/bots/bot_1/approval-rules")) return json({ rules: [approvalRule()] });
  if (path.startsWith("/api/bots")) return json({ bots: [bot] });
  if (path.startsWith("/api/cost-alert-rules"))
    return json({
      rules: [
        {
          id: "car_1",
          kind: "unpriced_usage",
          window: "day",
          createdBy: "human:usr_0",
          createdAt: "2026-10-09T00:00:00.000Z",
        },
      ],
      offset: 0,
      limit: 25,
      total: 1,
    });
  if (path.startsWith("/api/cost-alerts")) return json({ alerts: [], total: 0 });
  if (path.startsWith("/api/knowledge/proposals"))
    return json({
      proposals: [
        {
          id: "kp_1",
          title: "Site map",
          body: "Pages",
          status: "pending",
          createdAt: "2026-10-09T00:00:00.000Z",
        },
      ],
    });
  if (path.startsWith("/api/knowledge")) return json({ documents: [] });
  return json({ code: "not_found", message: `no ${path}` }, 404);
}

function api() {
  return createApiClient({
    fetch: vi.fn(async (input: RequestInfo | URL) => gatewayFetch(String(input))),
  });
}

describe("Integrations", () => {
  it("a Member sees what platform maintenance and Admins can do, and cannot start it", async () => {
    as(MEMBER, <IntegrationsScreen api={api()} />);
    const adopt = await screen.findByRole("button", { name: "Adopt" });
    expect(adopt).toBeDisabled();
    expect(
      screen.getByText("Only a platform maintainer can adopt or unadopt an app."),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Unadopt slack" })).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Add account" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Revoke slack/team" })).not.toBeInTheDocument();
    expect(
      screen.getByText("Only an Admin or Owner can connect or revoke an account."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Register a database" })).toBeDisabled();
    expect(screen.getByText("Only an Admin or Owner can register a database.")).toBeVisible();
  });

  it("an Admin connects accounts and databases but does not adopt apps", async () => {
    as(ADMIN, <IntegrationsScreen api={api()} />);
    expect(await screen.findByRole("button", { name: "Adopt" })).toBeDisabled();
    expect(
      screen.getByText("Only a platform maintainer can adopt or unadopt an app."),
    ).toBeVisible();
    await waitFor(() => expect(screen.getByRole("button", { name: "Add account" })).toBeEnabled());
    expect(await screen.findByRole("button", { name: "Revoke slack/team" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Register a database" })).toBeEnabled();
    expect(screen.queryByText(/Only an Admin or Owner/)).not.toBeInTheDocument();
  });

  it("a platform maintainer adopts and unadopts apps whatever the tenant role", async () => {
    as(MAINTAINER, <IntegrationsScreen api={api()} />);
    expect(await screen.findByRole("button", { name: "Adopt" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Unadopt slack" })).toBeEnabled();
    expect(screen.queryByText(/platform maintainer can/)).not.toBeInTheDocument();
    // Connecting is the tenant's configuration: this maintainer is only a Member here.
    expect(screen.getByRole("button", { name: "Register a database" })).toBeDisabled();
  });
});

describe("Workspace and bot configuration", () => {
  const editor = () => (
    <BotEditor
      api={api()}
      bot={bot}
      config={{ defaultModel: "m", cheapModel: "c", cronTimeZone: "UTC" } as never}
      timeZone="UTC"
      workspaceName="default"
      onSaved={() => undefined}
    />
  );

  it("a Member reads a bot's instructions, model, schedules and rules but changes none", async () => {
    as(MEMBER, editor());
    const soul = await screen.findByLabelText("SOUL.md for ops");
    expect(soul).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "Save SOUL.md" })).toBeDisabled();
    expect(screen.getByText("Only an Admin or Owner can edit a bot's instructions.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save model settings" })).toBeDisabled();
    expect(screen.getByText("Only an Admin or Owner can change a bot's model.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Add schedule" })).toBeDisabled();
    expect(screen.getByText("Only an Admin or Owner can change a bot's schedules.")).toBeVisible();
    const rules = await screen.findByRole("list", { name: "Approval rules for ops" });
    expect(within(rules).getByText(/browser_click/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Remove rule" })).not.toBeInTheDocument();
    expect(screen.queryByText("Write a rule by hand")).not.toBeInTheDocument();
    expect(
      screen.getByText("Only an Admin or Owner can write or remove an approval rule."),
    ).toBeVisible();
    // Using the bot stays open to a Member.
    expect(screen.getByRole("button", { name: "Start test conversation" })).toBeEnabled();
  });

  it("an Admin edits a bot's instructions, model, schedules and approval rules", async () => {
    as(ADMIN, editor());
    const soul = await screen.findByLabelText("SOUL.md for ops");
    expect(soul).not.toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "Save model settings" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Add schedule" })).toBeEnabled();
    expect(await screen.findByRole("button", { name: "Remove rule" })).toBeEnabled();
    expect(screen.getByText("Write a rule by hand")).toBeInTheDocument();
    expect(screen.queryByText(ROLE_NOTE)).not.toBeInTheDocument();
  });

  it("only an Admin changes a workspace's egress or creates workspaces and bots", async () => {
    as(MEMBER, <EgressEditor api={api()} workspace={workspace} onSaved={() => undefined} />);
    expect(screen.getByRole("button", { name: "Save egress allowlist" })).toBeDisabled();
    expect(
      screen.getByText("Only an Admin or Owner can change the allowed domains."),
    ).toBeVisible();
    cleanup();
    as(MEMBER, <ManagementScreen api={api()} />);
    expect(await screen.findByRole("button", { name: "Create workspace" })).toBeDisabled();
    expect(screen.getByText("Only an Admin or Owner can create a workspace.")).toBeVisible();
    expect(await screen.findByRole("button", { name: "Create bot" })).toBeDisabled();
    cleanup();
    as(ADMIN, <EgressEditor api={api()} workspace={workspace} onSaved={() => undefined} />);
    expect(screen.getByRole("button", { name: "Save egress allowlist" })).toBeEnabled();
    expect(screen.queryByText(ROLE_NOTE)).not.toBeInTheDocument();
  });
});

describe("Cost rules and Knowledge", () => {
  it("a Member acknowledges alerts but neither writes cost rules nor publishes Knowledge", async () => {
    as(MEMBER, <CostAlertsPanel api={api()} bots={[bot]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Manage rules (1)" }));
    const rules = await screen.findByRole("dialog", { name: "Alert rules" });
    expect(within(rules).getByText(/Unpriced usage/i)).toBeInTheDocument();
    expect(within(rules).queryByRole("button", { name: "Delete rule" })).not.toBeInTheDocument();
    // A read-only role never gets a creation form it cannot submit.
    expect(within(rules).getByRole("button", { name: "New rule" })).toBeDisabled();
    expect(within(rules).queryByRole("button", { name: "Create rule" })).not.toBeInTheDocument();
    expect(
      within(rules).getByText("Only an Admin or Owner can add or delete a cost alert rule."),
    ).toBeVisible();
    cleanup();
    as(MEMBER, <KnowledgePanel api={api()} />);
    expect(await screen.findByText("Site map")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve and publish" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
    expect(
      screen.getByText("Only an Admin or Owner can publish, reject or edit a document."),
    ).toBeInTheDocument();
    // Proposing is a Member's way in.
    fireEvent.click(screen.getByRole("button", { name: "New document" }));
    expect(screen.getByRole("button", { name: "Submit proposal" })).toBeEnabled();
  });

  it("an Admin writes cost rules and reviews proposals", async () => {
    as(ADMIN, <CostAlertsPanel api={api()} bots={[bot]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Manage rules (1)" }));
    const rules = await screen.findByRole("dialog", { name: "Alert rules" });
    expect(await within(rules).findByRole("button", { name: "Delete rule" })).toBeEnabled();
    fireEvent.click(within(rules).getByRole("button", { name: "New rule" }));
    expect(within(rules).getByRole("button", { name: "Create rule" })).toBeEnabled();
    cleanup();
    as(ADMIN, <KnowledgePanel api={api()} />);
    await screen.findByText("Site map");
    expect(screen.getByRole("button", { name: "Approve and publish" })).toBeEnabled();
    expect(screen.queryByText(ROLE_NOTE)).not.toBeInTheDocument();
  });
});

describe("People", () => {
  const people: TenantMemberView[] = [
    { userId: "usr_1", displayName: "Olive", loginName: "olive", role: "admin", status: "active" },
    { userId: "usr_2", displayName: "Mia", loginName: "mia", role: "member", status: "active" },
    { userId: "usr_3", displayName: "Ann", loginName: "ann", role: "admin", status: "active" },
    { userId: "usr_4", displayName: "Gus", loginName: "gus", role: "guest", status: "active" },
    {
      userId: "usr_root",
      displayName: "Administrator",
      loginName: "admin",
      role: "owner",
      status: "active",
      protected: true,
    },
  ];
  const client: MembersClient = {
    listMembers: async () => people,
    pageMembers: async () => ({ members: people, offset: 0, limit: 25, total: people.length }),
    pageInvitations: async () => ({ invitations: [], offset: 0, limit: 25, total: 0 }),
    updateMember: async () => undefined,
    createInvitation: async () => {
      throw new Error("not used");
    },
    revokeInvitation: async () => undefined,
    createAccount: async () => {
      throw new Error("not used");
    },
    updatePreferences: async () => ({}),
  };

  const row = (name: string) =>
    screen.getAllByRole("row").find((item) => item.textContent?.includes(name)) as HTMLElement;

  // ADR-0022 amendment 6 W4: an Admin switches Members and Guests and promotes to Admin; only an
  // Owner demotes or removes an Admin or grants Owner; the protected root is never changed.
  it("an Admin manages Members and Guests and is told only an Owner manages Admins", async () => {
    as(
      ADMIN,
      <MembersScreen client={client} tenantRole="admin" userId="usr_1" ssoProviders={[]} />,
    );
    await screen.findByText("Mia");
    expect(screen.getByLabelText("Role of Mia")).toBeEnabled();
    expect(screen.getByLabelText("Role of Gus")).toBeEnabled();
    expect(screen.queryByLabelText("Role of Ann")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Role of Administrator")).not.toBeInTheDocument();
    expect(within(row("Mia")).getByRole("button", { name: "Remove" })).toBeEnabled();
    expect(within(row("Ann")).queryByRole("button", { name: "Remove" })).toBeNull();
    expect(within(row("Administrator")).queryByRole("button")).toBeNull();
    expect(
      screen.getByText("Only an Owner can demote or remove an Admin, or grant Owner."),
    ).toBeVisible();
    expect(
      screen.queryByText("Only an Admin or Owner can change a role or invite an Admin."),
    ).toBeNull();
  });

  it("an Owner changes Admins too, never the protected root, with no note", async () => {
    as(
      OWNER,
      <MembersScreen client={client} tenantRole="owner" userId="usr_0" ssoProviders={[]} />,
    );
    expect(await screen.findByLabelText("Role of Mia")).toBeEnabled();
    expect(screen.getByLabelText("Role of Ann")).toBeEnabled();
    expect(within(row("Ann")).getByRole("button", { name: "Remove" })).toBeEnabled();
    expect(screen.queryByLabelText("Role of Administrator")).not.toBeInTheDocument();
    expect(within(row("Administrator")).queryByRole("button")).toBeNull();
    expect(screen.queryByText(ROLE_NOTE)).not.toBeInTheDocument();
  });

  it("a person who is Admin of one workspace and Member of another is offered People only there", async () => {
    const roles: SessionRoles = {
      tenantRole: "admin",
      platformMaintainer: false,
      workspaceRoles: { ws_a: "admin", ws_b: "member" },
    };
    as(
      roles,
      <MembersScreen
        client={client}
        tenantRole="admin"
        userId="usr_1"
        ssoProviders={[]}
        workspaceId="ws_b"
      />,
    );
    await screen.findByText("Mia");
    expect(screen.queryByLabelText("Role of Mia")).not.toBeInTheDocument();
    expect(
      screen.getByText("Only an Admin or Owner can change a role or invite an Admin."),
    ).toBeVisible();
  });
});

describe("the signed-in app", () => {
  beforeEach(() => {
    installFakeEventSource();
  });
  afterEach(() => {
    window.location.hash = "";
  });

  const session = (role: "member" | "admin", platformMaintainer: boolean) => ({
    authenticated: true,
    user: { id: "usr_1", displayName: "Mia", loginName: "mia" },
    tenant: { id: "tnt_default", name: "Default Tenant", role },
    session: {
      authenticatedAt: "2026-10-09T00:00:00.000Z",
      idleExpiresAt: "2026-10-16T00:00:00.000Z",
      absoluteExpiresAt: "2026-11-08T00:00:00.000Z",
    },
    csrfToken: "csrf",
    platformMaintainer,
  });

  for (const [label, role, maintainer, adoptEnabled] of [
    ["Member", "member", false, false],
    ["maintainer", "member", true, true],
  ] as const) {
    it(`reads the role from GET /auth/session for a ${label}`, async () => {
      window.location.hash = "#/integrations";
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const path = String(input);
          if (path === "/auth/session") return json(session(role, maintainer));
          if (path.startsWith("/api/threads")) return json({ threads: [] });
          if (path.startsWith("/api/approvals")) return json({ approvals: [] });
          return gatewayFetch(path);
        }),
      );
      render(<App />);
      const adopt = await screen.findByRole("button", { name: "Adopt" });
      if (adoptEnabled) expect(adopt).toBeEnabled();
      else expect(adopt).toBeDisabled();
    });
  }
});
