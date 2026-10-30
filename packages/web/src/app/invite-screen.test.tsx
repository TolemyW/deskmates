// @vitest-environment jsdom
// The invitation page for an open sign-up link (ADR-0022 amendment 4, issue #25): the recipient
// chooses username and password; the Gateway defaults the display name; a taken username keeps
// the non-secret input; a
// used, revoked or expired link says which; an existing account signs in on the page and joins.
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionFlows } from "../api/members-client.js";
import { App } from "../app.js";
import { installFakeEventSource } from "../test-support/fixtures.js";
import { InviteScreen } from "./invite-screen.js";

const PASSWORD = "a long password here";

beforeEach(() => {
  window.location.hash = "#/invite/tok_open";
  installFakeEventSource();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function signedIn(name = "Nia New") {
  return {
    authenticated: true,
    user: { id: "usr_9", displayName: name, loginName: "nia" },
    tenant: { id: "tnt_b", name: "Beta", role: "member" },
    session: {
      authenticatedAt: "2026-10-10T00:00:00.000Z",
      idleExpiresAt: "2026-10-17T00:00:00.000Z",
      absoluteExpiresAt: "2026-11-09T00:00:00.000Z",
    },
    csrfToken: "session-csrf",
  };
}

interface Call {
  path: string;
  body: Record<string, unknown> | undefined;
  csrf: string | null;
}

function gateway(
  options: {
    preview?: Response;
    accept?: (body: Record<string, unknown>) => Response;
  } = {},
) {
  const calls: Call[] = [];
  let session: ReturnType<typeof signedIn> | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ path, body, csrf: new Headers(init?.headers).get("x-deskmates-csrf") });
      if (path === "/auth/session")
        return json(
          session ?? { authenticated: false, setupRequired: false, loginCsrf: "login-csrf" },
        );
      if (path === "/auth/invitations/tok_open")
        return (
          options.preview?.clone() ??
          json({
            tenantName: "Beta",
            role: "member",
            target: { kind: "local_signup" },
            expiresAt: "2026-10-17T00:00:00.000Z",
          })
        );
      if (path === "/auth/login") {
        session = signedIn("Bea Existing");
        return json(session);
      }
      if (path === "/auth/invitations/accept")
        return options.accept ? options.accept(body) : json(signedIn());
      if (path === "/api/config")
        return json({ defaultModel: "m", cheapModel: "c", release: null });
      return json({ bots: [], threads: [], approvals: [], workspaces: [] });
    }),
  );
  return calls;
}

function fill(fields: { username?: string; password?: string; confirm?: string }) {
  if (fields.username !== undefined)
    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: fields.username },
    });
  if (fields.password !== undefined)
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: fields.password },
    });
  if (fields.confirm !== undefined)
    fireEvent.change(screen.getByLabelText("Confirm new password"), {
      target: { value: fields.confirm },
    });
}

it("asks only for username and password, then signs in to the team", async () => {
  const calls = gateway();
  render(<App />);
  expect(await screen.findByRole("heading", { name: "Join Beta" })).toBeInTheDocument();
  expect(screen.getByText("You are invited to join Beta as a Member.")).toBeInTheDocument();
  expect(screen.queryByLabelText(/display name|your name/i)).toBeNull();
  fill({ username: " nia ", password: PASSWORD, confirm: PASSWORD });
  fireEvent.click(screen.getByRole("button", { name: "Create account and join" }));
  await screen.findByText("member · Beta");
  expect(calls.find((c) => c.path === "/auth/invitations/accept")).toEqual({
    path: "/auth/invitations/accept",
    body: { token: "tok_open", loginName: "nia", password: PASSWORD },
    csrf: "login-csrf",
  });
  expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
});

it("checks the confirmation before sending anything", async () => {
  const calls = gateway();
  render(<App />);
  await screen.findByRole("heading", { name: "Join Beta" });
  fill({ username: "nia", password: PASSWORD, confirm: "something else" });
  fireEvent.click(screen.getByRole("button", { name: "Create account and join" }));
  expect(await screen.findByText("The new passwords do not match.")).toBeInTheDocument();
  expect(calls.some((c) => c.path === "/auth/invitations/accept")).toBe(false);
});

it("keeps the username when it is taken and clears the passwords", async () => {
  gateway({
    accept: () =>
      json(
        {
          code: "invalid_transition",
          message: "That username is already taken",
          details: { reason: "login_name_taken" },
        },
        409,
      ),
  });
  render(<App />);
  await screen.findByRole("heading", { name: "Join Beta" });
  fill({ username: "olive", password: PASSWORD, confirm: PASSWORD });
  fireEvent.click(screen.getByRole("button", { name: "Create account and join" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/already taken/);
  expect(screen.getByLabelText("Username")).toHaveValue("olive");
  expect(screen.getByLabelText("Password")).toHaveValue("");
  expect(screen.getByLabelText("Confirm new password")).toHaveValue("");
});

for (const [reason, text] of [
  ["used", "This invitation has already been used."],
  ["revoked", "This invitation was revoked."],
  ["expired", "This invitation has expired."],
] as const) {
  it(`says the link was ${reason}`, async () => {
    gateway({
      preview: json({ code: "invitation_unusable", message: reason, details: { reason } }, 410),
    });
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    expect(screen.getByText(/Ask the person who invited you/)).toBeInTheDocument();
  });
}

it("lets an existing account sign in on the page and join with it", async () => {
  const calls = gateway({ accept: () => json({ joined: true, tenantId: "tnt_b" }) });
  render(<App />);
  await screen.findByRole("heading", { name: "Join Beta" });
  fireEvent.click(screen.getByRole("button", { name: "Already have an account? Sign in to join" }));
  fireEvent.change(screen.getByLabelText("Login name"), { target: { value: "bea" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: PASSWORD } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  fireEvent.click(await screen.findByRole("button", { name: "Join as Bea Existing" }));
  await waitFor(() =>
    expect(calls.find((c) => c.path === "/auth/invitations/accept")).toEqual({
      path: "/auth/invitations/accept",
      body: { token: "tok_open" },
      csrf: "session-csrf",
    }),
  );
});

it("dates the expiry in the page's language, not the browser default (#63 L23)", async () => {
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["ja"]);
  gateway();
  render(<App />);
  const when = new Date("2026-10-17T00:00:00.000Z").toLocaleString("ja");
  expect(await screen.findByText((text) => text.includes(when))).toBeInTheDocument();
});

it("retries transient invitation reads without declaring the link invalid", async () => {
  const previewInvitation = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({
      tenantName: "Recovered team",
      role: "member",
      target: { kind: "local_signup" },
      expiresAt: "2027-01-01T00:00:00Z",
    });
  render(
    <InviteScreen
      flows={{ previewInvitation } as unknown as SessionFlows}
      token="test-token"
      session={undefined}
      loginCsrf="csrf"
      onSignedIn={() => {}}
      onJoined={() => {}}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not load this invitation");
  expect(screen.queryByText(/This invitation is not valid/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByLabelText("Username");
  expect(previewInvitation).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("clears the old invitation form while a different link loads", async () => {
  const preview = {
    tenantName: "First team",
    role: "member",
    target: { kind: "local_signup" },
    expiresAt: "2027-01-01T00:00:00Z",
  };
  let finish!: (value: typeof preview) => void;
  const previewInvitation = vi
    .fn()
    .mockResolvedValueOnce(preview)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  const props = {
    flows: { previewInvitation } as unknown as SessionFlows,
    session: undefined,
    loginCsrf: "csrf",
    onSignedIn: () => {},
    onJoined: () => {},
  };
  const view = render(<InviteScreen {...props} token="first" />);
  await screen.findByLabelText("Username");
  fill({ username: "unfinished", password: PASSWORD, confirm: PASSWORD });
  view.rerender(<InviteScreen {...props} token="second" />);
  expect(screen.queryByLabelText("Username")).toBeNull();
  expect(screen.getByText("Checking your invitation…")).toBeInTheDocument();
  await act(async () => {
    finish({ ...preview, tenantName: "Second team" });
  });
  expect(await screen.findByLabelText("Username")).toHaveValue("");
  expect(screen.getByLabelText("Password")).toHaveValue("");
});

it("prevents repeated SSO invitation starts and restores the button after failure", async () => {
  let rejectStart: (reason: Error) => void = () => {};
  const startSso = vi.fn(
    () =>
      new Promise((_resolve, reject) => {
        rejectStart = reject;
      }),
  );
  const flows = {
    previewInvitation: vi.fn(async () => ({
      tenantName: "Demo",
      role: "member",
      target: { kind: "oidc_email", email: "demo@example.test", providerId: "sso-test" },
      provider: { id: "sso-test", displayName: "Example" },
    })),
    startSso,
  } as unknown as SessionFlows;
  render(
    <InviteScreen
      flows={flows}
      token="test-token"
      session={undefined}
      loginCsrf="test-csrf"
      onSignedIn={() => {}}
      onJoined={() => {}}
    />,
  );
  const button = await screen.findByRole("button", { name: /Continue with Example/ });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(button).toBeDisabled();
  expect(startSso).toHaveBeenCalledOnce();
  await act(async () => {
    rejectStart(new Error("offline"));
  });
  expect(screen.getByRole("alert")).toBeInTheDocument();
  expect(button).toBeEnabled();
});
