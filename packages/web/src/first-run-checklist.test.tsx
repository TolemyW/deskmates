// @vitest-environment jsdom
// T0, issue #22: the home screen shows Owners and Admins a first-run checklist until they dismiss
// it. Each item is checked from live data (workspaces, bots, chats, people), never from clicks,
// and dismissal is the person's stored preference: `PATCH /auth/preferences`, then reported by
// `GET /auth/session` on every later load. Members never see it.
import "@testing-library/jest-dom/vitest";
import { CSRF_HEADER, type TenantRole, type UserPreferences } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./app.js";
import { bot, installFakeEventSource, thread, workspace } from "./test-support/fixtures.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Data {
  role: TenantRole;
  preferences?: UserPreferences;
  workspaces?: unknown[];
  bots?: unknown[];
  threads?: unknown[];
  members?: unknown[];
  invitations?: unknown[];
}

const ME = {
  userId: "usr_1",
  displayName: "Pat",
  loginName: "pat",
  role: "owner",
  status: "active",
};

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A Gateway holding `data`; a PATCH of preferences is stored and reported by later sessions. */
function stubGateway(data: Data): Call[] {
  const calls: Call[] = [];
  let preferences = data.preferences ?? {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, headers: (init?.headers ?? {}) as Record<string, string>, body });
      if (path === "/auth/preferences" && method === "PATCH") {
        preferences = { ...preferences, ...(body as UserPreferences) };
        return json({ preferences });
      }
      if (path === "/auth/session")
        return json({
          authenticated: true,
          user: { id: "usr_1", displayName: "Pat", loginName: "pat" },
          tenant: { id: "tnt_default", name: "Default Tenant", role: data.role },
          session: {
            authenticatedAt: "2026-10-05T00:00:00.000Z",
            idleExpiresAt: "2026-10-12T00:00:00.000Z",
            absoluteExpiresAt: "2026-11-04T00:00:00.000Z",
          },
          csrfToken: "session-csrf-1",
          preferences,
        });
      if (path === "/api/config") return json({ release: null });
      if (path.startsWith("/api/workspaces")) return json({ workspaces: data.workspaces ?? [] });
      if (path.startsWith("/api/bots")) return json({ bots: data.bots ?? [] });
      if (path.startsWith("/api/threads")) return json({ threads: data.threads ?? [] });
      // Offset pages with totals (#113 slice M); the checklist reads the totals.
      if (path.startsWith("/api/members")) {
        const members = data.members ?? [ME];
        return json({ members, offset: 0, limit: 25, total: members.length });
      }
      if (path.startsWith("/api/invitations")) {
        const invitations = data.invitations ?? [];
        return json({ invitations, offset: 0, limit: 25, total: invitations.length });
      }
      if (path.startsWith("/api/approvals")) return json({ approvals: [] });
      return json({ code: "not_found", message: `no ${path}` }, 404);
    }),
  );
  return calls;
}

/** The checklist's items in order, each as "Done: …" or "To do: …". */
async function items(): Promise<string[]> {
  const list = await screen.findByRole("list", { name: "First steps" });
  return within(list)
    .getAllByRole("listitem")
    .map((item) => item.textContent ?? "");
}

beforeEach(() => {
  window.location.hash = "#/";
  installFakeEventSource();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("first-run checklist", () => {
  it("shows an Owner of an empty team every step still to do", async () => {
    stubGateway({ role: "owner" });
    render(<App />);
    expect(await items()).toEqual([
      "To do: Create a workspace",
      "To do: Create a bot",
      "To do: Open a chat",
      "To do: Invite a person",
    ]);
  });

  it("checks each step for an Admin from what already exists", async () => {
    stubGateway({
      role: "admin",
      workspaces: [workspace],
      bots: [bot],
      threads: [{ ...thread, memberIds: [bot.id] }],
      invitations: [
        {
          id: "inv_1",
          role: "member",
          status: "open",
          target: { kind: "local_new", loginName: "x" },
        },
      ],
    });
    render(<App />);
    await waitFor(async () =>
      expect(await items()).toEqual([
        "Done: Create a workspace",
        "Done: Create a bot",
        "Done: Open a chat",
        "Done: Invite a person",
      ]),
    );
  });

  it("counts a second member as an invited person", async () => {
    stubGateway({
      role: "owner",
      workspaces: [workspace],
      bots: [bot],
      threads: [{ ...thread, memberIds: [bot.id] }],
      members: [ME, { ...ME, userId: "usr_2", displayName: "Sam", role: "member" }],
    });
    render(<App />);
    await waitFor(async () => expect((await items())[3]).toBe("Done: Invite a person"));
  });

  it("is not shown to a Member, who is not asked for people either", async () => {
    const calls = stubGateway({ role: "member", workspaces: [workspace], bots: [bot] });
    render(<App />);
    await screen.findByRole("navigation", { name: "Main navigation" });
    await screen.findByText(/one team, one computer/);
    expect(screen.queryByRole("region", { name: "First steps" })).toBeNull();
    expect(calls.some((call) => call.path.startsWith("/api/members"))).toBe(false);
  });

  it("is not shown once the person dismissed it", async () => {
    stubGateway({ role: "owner", preferences: { firstRunChecklistDismissed: true } });
    render(<App />);
    await screen.findByText(/Your team|one team, one computer/);
    expect(screen.queryByRole("region", { name: "First steps" })).toBeNull();
  });

  it("stores the dismissal as a preference and stays dismissed after a reload", async () => {
    const calls = stubGateway({ role: "owner" });
    const first = render(<App />);
    const region = await screen.findByRole("region", { name: "First steps" });
    fireEvent.click(within(region).getByRole("button", { name: "Dismiss checklist" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "First steps" })).toBeNull());
    const patch = calls.find((call) => call.method === "PATCH");
    expect(patch?.path).toBe("/auth/preferences");
    expect(patch?.body).toEqual({ firstRunChecklistDismissed: true });
    expect(patch?.headers[CSRF_HEADER]).toBe("session-csrf-1");

    // A reload asks the Gateway for the session again; the stored preference keeps it hidden.
    first.unmount();
    render(<App />);
    await screen.findByText(/Your team|one team, one computer/);
    expect(screen.queryByRole("region", { name: "First steps" })).toBeNull();
  });

  it("keeps the checklist and says so when the Gateway refuses the dismissal", async () => {
    stubGateway({ role: "owner" });
    const failing = vi.mocked(fetch);
    const original = failing.getMockImplementation();
    failing.mockImplementation(async (input, init) =>
      String(input) === "/auth/preferences"
        ? json({ code: "unavailable", message: "down" }, 503)
        : (original as typeof fetch)(input, init),
    );
    render(<App />);
    const region = await screen.findByRole("region", { name: "First steps" });
    fireEvent.click(within(region).getByRole("button", { name: "Dismiss checklist" }));
    expect(await within(region).findByRole("alert")).toHaveTextContent(
      "The checklist could not be dismissed. Try again.",
    );
    expect(screen.getByRole("region", { name: "First steps" })).toBeInTheDocument();
  });
});
