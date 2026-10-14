// T0 golden for the auth, account and members clients: every method's exact request (method,
// URL, headers, body, credentials, cache) and how it surfaces the answer, an error body and a 401.
// `__golden__/session-clients.golden.txt` (JSON; `.txt` so the formatter leaves it byte-exact) is
// the contract; regenerate with `vitest -u` only for an intended wire change.

import { describe, expect, it } from "vitest";
import { type AccountClient, createAccountClient } from "./account-client.js";
import { type AuthClient, createAuthClient } from "./auth-client.js";
import {
  type MembersClient,
  type SessionFlows,
  createMembersClient,
  createSessionFlows,
} from "./members-client.js";
import { ApiError } from "./types.js";

type Reply = "ok" | "error" | "unauthorized" | "network";

interface Recorded {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
  credentials: RequestCredentials | undefined;
  cache: RequestCache | undefined;
}

function recordingFetch(reply: Reply): { fetch: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = Object.entries((init?.headers ?? {}) as Record<string, string>).map(
      ([k, v]) => [k.toLowerCase(), v] as const,
    );
    const body = init?.body;
    calls.push({
      url: String(input),
      method: init?.method,
      headers: Object.fromEntries([...headers].sort(([a], [b]) => a.localeCompare(b))),
      body:
        typeof body === "string"
          ? JSON.parse(body)
          : body instanceof Blob
            ? { blobSize: body.size }
            : body,
      credentials: init?.credentials,
      cache: init?.cache,
    });
    switch (reply) {
      case "network":
        throw new TypeError("Failed to fetch");
      case "unauthorized":
        return new Response("{}", { status: 401 });
      case "error":
        return new Response(
          JSON.stringify({ code: "forbidden", message: "No", details: { why: "x" } }),
          { status: 403 },
        );
      case "ok":
        return new Response(
          JSON.stringify({ members: "<m>", invitations: "<i>", preferences: "<p>", ok: true }),
          {
            status: 200,
          },
        );
    }
  };
  return { fetch: impl as typeof fetch, calls };
}

interface Clients {
  auth: AuthClient;
  account: AccountClient;
  members: MembersClient;
  flows: SessionFlows;
}

const CASES: Record<string, (c: Clients) => Promise<unknown>> = {
  "account.changePassword": (c) => c.account.changePassword("old", "new"),
  "account.createAgentToken": (c) => c.account.createAgentToken("ci"),
  "account.removeAvatar": (c) => c.account.removeAvatar(),
  "account.updateDisplayName": (c) => c.account.updateDisplayName("Ada"),
  "account.uploadAvatar": (c) => c.account.uploadAvatar(new Blob(["png"]), "image/png"),
  "auth.getSession": (c) => c.auth.getSession(),
  "auth.login": (c) => c.auth.login("ada", "pw", "login-csrf"),
  "auth.logout": (c) => c.auth.logout("csrf-x"),
  "auth.logoutAll": (c) => c.auth.logoutAll("csrf-x"),
  "flows.acceptInvitation": (c) => c.flows.acceptInvitation({ token: "tok/1" }, "csrf-x"),
  "flows.getSession": (c) => c.flows.getSession("tn_9"),
  "flows.getSessionNoTenant": (c) => c.flows.getSession(),
  "flows.previewInvitation": (c) => c.flows.previewInvitation("tok/1"),
  "flows.startSso": (c) => c.flows.startSso("corp/1", { returnTo: "/" } as never, "csrf-x"),
  "members.createAccount": (c) =>
    c.members.createAccount({
      loginName: "bo",
      displayName: "Bo",
      role: "guest",
      workspaceId: "ws/1",
    }),
  "members.createInvitation": (c) =>
    c.members.createInvitation({ role: "member", workspaceId: "ws/1" } as never),
  "members.listMembers": (c) => c.members.listMembers("ws/1"),
  "members.listMembersNoWorkspace": (c) => c.members.listMembers(),
  "members.pageInvitations": (c) => c.members.pageInvitations("ws/1", { offset: 25, limit: 25 }),
  "members.pageInvitationsNoWorkspace": (c) => c.members.pageInvitations(undefined, {}),
  "members.pageMembers": (c) =>
    c.members.pageMembers("ws/1", { offset: 50, limit: 25, role: "guest", status: "active" }),
  "members.pageMembersNoWorkspace": (c) => c.members.pageMembers(undefined, {}),
  "members.revokeInvitation": (c) => c.members.revokeInvitation("inv/1", "ws/1"),
  "members.updateMember": (c) =>
    c.members.updateMember("u/1", { role: "admin", workspaceId: "ws/1" }),
  "members.updatePreferences": (c) => c.members.updatePreferences({ locale: "en" } as never),
};

async function surface(value: unknown): Promise<unknown> {
  if (value instanceof ApiError) {
    return {
      error: value.name,
      code: value.code,
      message: value.message,
      status: value.status,
      details: value.details,
    };
  }
  return value === undefined ? "<undefined>" : value;
}

async function exercise(name: string, reply: Reply) {
  const { fetch, calls } = recordingFetch(reply);
  let unauthorized = 0;
  const onUnauthorized = () => {
    unauthorized += 1;
  };
  const shared = { baseUrl: "https://gw.test", fetch };
  const scoped = { ...shared, csrfToken: () => "csrf-1", tenantId: "tn_1", onUnauthorized };
  const clients: Clients = {
    auth: createAuthClient(shared),
    account: createAccountClient(scoped),
    members: createMembersClient(scoped),
    flows: createSessionFlows(shared),
  };
  let outcome: Record<string, unknown>;
  try {
    outcome = {
      resolved: await surface(await (CASES[name] as (c: Clients) => Promise<unknown>)(clients)),
    };
  } catch (err) {
    outcome = { rejected: await surface(err) };
  }
  return { calls, outcome, notified: unauthorized };
}

describe("session clients golden requests", () => {
  it("pins every method's request and answer, and its failure surfaces", async () => {
    const golden: Record<string, unknown> = {};
    for (const name of Object.keys(CASES).sort()) {
      const ok = await exercise(name, "ok");
      const unauthorized = await exercise(name, "unauthorized");
      const error = await exercise(name, "error");
      const network = await exercise(name, "network");
      golden[name] = {
        requests: ok.calls,
        ok: ok.outcome,
        unauthorized: { ...unauthorized.outcome, notified: unauthorized.notified },
        error: { ...error.outcome, notified: error.notified },
        network: network.outcome,
      };
    }
    await expect(`${JSON.stringify(golden, null, 2)}\n`).toMatchFileSnapshot(
      "./__golden__/session-clients.golden.txt",
    );
  });
});
