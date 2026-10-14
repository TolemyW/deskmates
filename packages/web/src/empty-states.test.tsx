// @vitest-environment jsdom
// T0, issue #22: every list screen's empty state names the next action and who may take it,
// for a role that may (Admin, or any member) and one that may not (Member). The words come from
// `NextAction` over `ROLE_ACTIONS`; the Gateway still decides.
import "@testing-library/jest-dom/vitest";
import type {
  InvitationView,
  SessionRoles,
  TenantMemberView,
  ThreadSummary,
} from "@deskmates/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "./api/client.js";
import type { MembersClient } from "./api/members-client.js";
import { ApprovalsScreen } from "./features/approvals/approvals.js";
import { ThreadRail } from "./features/chats/thread-rail.js";
import { ComputerScreen } from "./features/computer/computer.js";
import { ContactsScreen } from "./features/contacts/contacts.js";
import { IntegrationsScreen } from "./features/integrations/integrations.js";
import { MembersScreen } from "./features/members/members.js";
import { TasksScreen } from "./features/tasks/tasks.js";
import { SessionRolesProvider } from "./state/session-roles.js";
import {
  WS_ID,
  bot,
  fakeFetch,
  installFakeEventSource,
  thread,
  workspace,
} from "./test-support/fixtures.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

const MEMBER: SessionRoles = { tenantRole: "member", platformMaintainer: false };
const ADMIN: SessionRoles = { tenantRole: "admin", platformMaintainer: false };

function as(roles: SessionRoles, ui: ReactNode) {
  return render(<SessionRolesProvider roles={roles}>{ui}</SessionRolesProvider>);
}

function api(routes: Parameters<typeof fakeFetch>[0]) {
  return createApiClient({ fetch: fakeFetch(routes).fetch });
}

/** The one next-action line of a screen. */
async function nextAction(): Promise<string> {
  const line = await screen.findByTestId("next-action");
  return line.textContent ?? "";
}

describe("no workspaces", () => {
  it("offers an Admin the first-run form and names the step", async () => {
    as(ADMIN, <ThreadRail workspace={undefined} bots={[]} threads={[]} onCreated={() => {}} />);
    expect(await nextAction()).toBe(
      "Next: create a workspace, its first bot and a chat with the form below. An Admin or Owner can do this.",
    );
    expect(screen.getByLabelText("First run")).toBeInTheDocument();
  });

  it("tells a Member who can create a workspace instead of a form that would be refused", async () => {
    as(MEMBER, <ThreadRail workspace={undefined} bots={[]} threads={[]} onCreated={() => {}} />);
    expect(await nextAction()).toBe(
      "Next: ask an Admin or Owner to create a workspace. Only an Admin or Owner can.",
    );
    expect(screen.queryByLabelText("First run")).toBeNull();
  });

  it("says the step on the Computer screen and disables New workspace for a Member", async () => {
    installFakeEventSource();
    as(MEMBER, <ComputerScreen api={api({ "GET /api/workspaces": { workspaces: [] } })} />);
    expect(await nextAction()).toBe(
      "Next: ask an Admin or Owner to create a workspace. Only an Admin or Owner can.",
    );
    expect(screen.getByRole("button", { name: "New workspace" })).toBeDisabled();
  });

  it("says the step on the tasks screen", async () => {
    as(ADMIN, <TasksScreen api={api({ "GET /api/workspaces": { workspaces: [] } })} />);
    expect(await nextAction()).toBe(
      "Next: create a workspace with New workspace in the workspace switcher. An Admin or Owner can do this.",
    );
  });
});

describe("no bots", () => {
  const routes = {
    "GET /api/workspaces": { workspaces: [workspace] },
    "GET /api/bots": { bots: [] },
    "GET /api/runs": { runs: [] },
  };

  it("tells a Member who can add a bot", async () => {
    installFakeEventSource();
    as(MEMBER, <ContactsScreen api={api(routes)} />);
    expect(await nextAction()).toBe(
      "Next: ask an Admin or Owner to add a bot. Only an Admin or Owner can.",
    );
  });

  it("tells an Admin where to add one", async () => {
    installFakeEventSource();
    as(ADMIN, <ContactsScreen api={api(routes)} />);
    expect(await nextAction()).toBe(
      "Next: add a bot with New contact. An Admin or Owner can do this.",
    );
  });
});

describe("no chats", () => {
  it("names New chat and that anyone in the workspace may start one", async () => {
    as(MEMBER, <ThreadRail workspace={workspace} bots={[]} threads={[]} onCreated={() => {}} />);
    expect(await screen.findByText("No chats yet.")).toBeInTheDocument();
    // The create dialog also opens by itself and names its own step (add a bot).
    expect(
      within(screen.getByRole("complementary", { hidden: true })).getByTestId("next-action")
        .textContent,
    ).toBe("Next: start a chat with New chat. Anyone in the workspace can do this.");
  });

  it("lists each bot's inbox instead when the workspace has bots but no chats (issue #29)", () => {
    as(MEMBER, <ThreadRail workspace={workspace} bots={[bot]} threads={[]} onCreated={() => {}} />);
    expect(screen.queryByText("No chats yet.")).toBeNull();
    expect(screen.queryByTestId("next-action")).toBeNull();
    expect(screen.getByRole("button", { name: "Private chat with ops" })).toBeInTheDocument();
  });

  it("says nothing when chats exist", () => {
    const summary: ThreadSummary = { ...thread, memberIds: [bot.id] };
    as(
      MEMBER,
      <ThreadRail workspace={workspace} bots={[bot]} threads={[summary]} onCreated={() => {}} />,
    );
    expect(screen.queryByTestId("next-action")).toBeNull();
  });
});

describe("no tasks", () => {
  it("asks a Member to have an Admin add a task (ADR-0022 amendment 1)", async () => {
    as(
      MEMBER,
      <TasksScreen
        api={api({
          "GET /api/workspaces": { workspaces: [workspace] },
          [`GET /api/bots?workspaceId=${WS_ID}`]: { bots: [bot] },
          [`GET /api/workspaces/${WS_ID}/tasks?offset=0&limit=25`]: {
            tasks: [],
            offset: 0,
            limit: 25,
            total: 0,
            statusCounts: {
              planned: 0,
              in_progress: 0,
              blocked: 0,
              delivered: 0,
              accepted: 0,
              cancelled: 0,
            },
          },
        })}
      />,
    );
    expect(await screen.findByText("No tasks yet.")).toBeInTheDocument();
    expect(await nextAction()).toBe(
      "Next: ask an Admin or Owner to add a task. Only an Admin or Owner can.",
    );
  });
});

describe("no approvals", () => {
  it("says what will appear and who may decide it", async () => {
    installFakeEventSource();
    as(
      MEMBER,
      <ApprovalsScreen
        api={api({
          "GET /api/approvals?status=pending": { approvals: [] },
          "GET /api/bots": { bots: [] },
        })}
      />,
    );
    expect(await screen.findByText(/Nothing pending/)).toBeInTheDocument();
    expect(await nextAction()).toBe(
      "Next: decide a request here or in its chat when a bot asks before an external action. Any member can do this.",
    );
  });
});

describe("no connections", () => {
  const routes = {
    "GET /api/workspaces": { workspaces: [workspace] },
    "GET /api/integrations": { configured: true, oauthAvailable: false, providers: [] },
    "GET /api/integrations/catalog": { configured: true, complete: true, providers: [] },
    [`GET /api/integrations/workspaces/${WS_ID}/connections?status=live&offset=0&limit=25`]: {
      connections: [],
      offset: 0,
      limit: 25,
      total: 0,
      liveByService: [],
    },
    [`GET /api/connectors?workspaceId=${WS_ID}&offset=0&limit=25`]: {
      connectors: [],
      offset: 0,
      limit: 25,
      total: 0,
    },
  };

  it("tells a Member who can connect one", async () => {
    as(MEMBER, <IntegrationsScreen api={api(routes)} />);
    expect(await screen.findByText("No connections yet.")).toBeInTheDocument();
    expect(await nextAction()).toBe(
      "Next: ask an Admin or Owner to connect an account of an adopted app or register a database. Only an Admin or Owner can.",
    );
  });

  it("tells an Admin what to connect", async () => {
    as(ADMIN, <IntegrationsScreen api={api(routes)} />);
    expect(await nextAction()).toBe(
      "Next: connect an account of an adopted app or register a database. An Admin or Owner can do this.",
    );
  });
});

describe("no people invited", () => {
  function people(members: TenantMemberView[], invitations: InvitationView[]): MembersClient {
    return {
      listMembers: vi.fn(async () => members),
      pageMembers: vi.fn(async () => ({ members, offset: 0, limit: 25, total: members.length })),
      pageInvitations: vi.fn(async () => ({
        invitations,
        offset: 0,
        limit: 25,
        total: invitations.length,
      })),
      updateMember: vi.fn(async () => {}),
      createInvitation: vi.fn(),
      revokeInvitation: vi.fn(async () => {}),
    } as unknown as MembersClient;
  }
  const me: TenantMemberView = {
    userId: "usr_1",
    displayName: "Olive",
    loginName: "olive",
    role: "owner",
    status: "active",
  } as TenantMemberView;

  it("names the invitation form when the Owner is alone", async () => {
    render(
      <MembersScreen
        client={people([me], [])}
        tenantRole="owner"
        userId="usr_1"
        ssoProviders={[]}
      />,
    );
    expect(await screen.findByText("Nobody else is in this team yet.")).toBeInTheDocument();
    expect(await nextAction()).toBe(
      "Next: invite someone with Invite by link or Create account below. An Admin or Owner can do this.",
    );
  });

  it("says nothing once someone is invited", async () => {
    const invitation = {
      id: "inv_1",
      role: "member",
      status: "open",
      target: { kind: "local_new", loginName: "pat" },
    } as unknown as InvitationView;
    render(
      <MembersScreen
        client={people([me], [invitation])}
        tenantRole="owner"
        userId="usr_1"
        ssoProviders={[]}
      />,
    );
    const list = await screen.findByRole("list");
    await within(list).findByText(/pat/);
    expect(screen.queryByTestId("next-action")).toBeNull();
  });
});
