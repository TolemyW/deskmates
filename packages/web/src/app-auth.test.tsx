// @vitest-environment jsdom
// ADR-0022 P1 sign-in in the browser (test plan AUTH-01, AUTH-03, AUTH-04 Web). The session is
// an HttpOnly cookie the page never sees: the UI asks `/auth/session` on load, signs in with a
// login name and password, keeps no credential in storage or URLs, opens streams only once
// signed in, and returns to the sign-in screen when the Gateway ends the session.
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./app.js";
import { FakeEventSource, installFakeEventSource } from "./test-support/fixtures.js";

beforeEach(() => {
  window.location.hash = "#/threads";
  installFakeEventSource();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

const PASSWORD = "right password for tests";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function apiResponse(path: string, release: string | null): Response {
  const body =
    path === "/api/config"
      ? { defaultModel: "configured-main", cheapModel: "configured-cheap", release }
      : path.startsWith("/api/workspaces")
        ? { workspaces: [] }
        : path.startsWith("/api/bots")
          ? { bots: [] }
          : path.startsWith("/api/threads")
            ? { threads: [] }
            : { approvals: [] };
  return json(body);
}

interface Call {
  method: string;
  path: string;
  headers: Headers;
  credentials: RequestCredentials | undefined;
  body: unknown;
}

/** A fake Gateway that holds the session the way the real one does: server-side. */
function fakeGateway(
  initial: { signedIn?: boolean; setupRequired?: boolean; release?: string | null } = {},
) {
  const state = {
    signedIn: initial.signedIn ?? false,
    setupRequired: initial.setupRequired ?? false,
    release: initial.release ?? null,
    csrf: "session-csrf-1",
    loginCsrf: "login-csrf-1",
    offline: false,
    revoked: false,
    loginStatus: undefined as number | undefined,
  };
  const calls: Call[] = [];
  const signedInView = () => ({
    authenticated: true,
    user: { id: "usr_1", displayName: "Olive Owner", loginName: "olive" },
    tenant: { id: "tnt_default", name: "Default Tenant", role: "owner" },
    session: {
      authenticatedAt: "2026-10-05T00:00:00.000Z",
      idleExpiresAt: "2026-10-12T00:00:00.000Z",
      absoluteExpiresAt: "2026-11-04T00:00:00.000Z",
    },
    csrfToken: state.csrf,
  });
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, headers, credentials: init?.credentials, body });
    if (state.offline) throw new TypeError("Failed to fetch");
    const live = state.signedIn && !state.revoked;
    if (path === "/auth/session")
      return json(
        live
          ? signedInView()
          : {
              authenticated: false,
              setupRequired: state.setupRequired,
              loginCsrf: state.loginCsrf,
            },
      );
    if (path === "/auth/login") {
      if (headers.get("x-deskmates-csrf") !== state.loginCsrf)
        return json({ code: "forbidden", message: "csrf", details: { reason: "login_csrf" } }, 403);
      if (state.loginStatus === 429)
        return json(
          { code: "rate_limited", message: "slow down", details: { retryAfterSeconds: 600 } },
          429,
        );
      if (body?.password !== PASSWORD)
        return json(
          { code: "token_rejected", message: "Login name or password is incorrect" },
          401,
        );
      state.signedIn = true;
      state.revoked = false;
      return json(signedInView());
    }
    if (path === "/auth/logout" || path === "/auth/logout-all") {
      if (headers.get("x-deskmates-csrf") !== state.csrf)
        return json({ code: "forbidden", message: "csrf", details: { reason: "csrf" } }, 403);
      state.signedIn = false;
      return json({ signedOut: true });
    }
    if (!live) return json({ code: "token_rejected", message: "not signed in" }, 401);
    return apiResponse(path, state.release);
  });
  vi.stubGlobal("fetch", fetch);
  return { state, calls, fetch };
}

async function signIn(loginName = "olive", password = PASSWORD) {
  fireEvent.change(await screen.findByLabelText("Login name"), { target: { value: loginName } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

function expectNoCredentialStored(): void {
  expect(window.localStorage.length).toBe(0);
  expect(window.sessionStorage.length).toBe(0);
  expect(window.location.href).not.toMatch(/token|csrf|password/i);
  for (const es of FakeEventSource.instances) expect(es.url).not.toMatch(/token|csrf/i);
}

it("restores a signed-in browser on load without asking for anything", async () => {
  const gw = fakeGateway({ signedIn: true });
  render(<App />);
  await screen.findByText("Olive Owner");
  expect(screen.queryByLabelText("Password")).toBeNull();
  expect(screen.getByText("Olive Owner")).toBeInTheDocument();
  expect(screen.getByText(/owner · Default Tenant/)).toBeInTheDocument();
  const stream = await waitFor(() => FakeEventSource.forUrl("/api/events?tenant=tnt_default"));
  // The stream names the tab's tenant (ADR-0022 P4); EventSource cannot send the header.
  expect(stream.url).toBe("/api/events?tenant=tnt_default");
  // No request carries a bearer credential; every request lets the browser send the cookie.
  for (const call of gw.calls) {
    expect(call.headers.get("authorization")).toBeNull();
    expect(call.credentials).toBe("same-origin");
  }
  expectNoCredentialStored();
});

it("signs in with a login name and password, then opens the app and its streams", async () => {
  const gw = fakeGateway();
  render(<App />);
  await screen.findByLabelText("Login name");
  expect(FakeEventSource.instances).toHaveLength(0);
  await signIn();
  await screen.findByText("Olive Owner");
  const login = gw.calls.find((call) => call.path === "/auth/login");
  expect(login?.method).toBe("POST");
  expect(login?.headers.get("x-deskmates-csrf")).toBe("login-csrf-1");
  expect(login?.body).toEqual({ loginName: "olive", password: PASSWORD });
  await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
  expectNoCredentialStored();
});

it("a reload after signing in stays signed in (the cookie lives in the browser)", async () => {
  fakeGateway();
  render(<App />);
  await signIn();
  await screen.findByText("Olive Owner");
  cleanup(); // the page goes away; the browser keeps its cookie, which the fake Gateway models
  render(<App />);
  await screen.findByText("Olive Owner");
  expect(screen.queryByLabelText("Password")).toBeNull();
});

it("rejects a wrong password without opening streams and permits retry", async () => {
  fakeGateway();
  render(<App />);
  await signIn("olive", "wrong password!!");
  expect(await screen.findByRole("alert")).toHaveTextContent("login name or password is incorrect");
  expect(FakeEventSource.instances).toHaveLength(0);
  expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
  await signIn();
  await screen.findByText("Olive Owner");
});

it("explains throttling", async () => {
  const gw = fakeGateway();
  gw.state.loginStatus = 429;
  render(<App />);
  await signIn();
  expect(await screen.findByRole("alert")).toHaveTextContent("Try again in 10 minute(s)");
});

it("tells a visitor of an unconfigured Gateway how the first Owner is created", async () => {
  fakeGateway({ setupRequired: true });
  render(<App />);
  const setup = await screen.findByText(/No account exists yet/);
  expect(setup).toHaveTextContent("bootstrap-owner");
});

it("keeps the sidebar identity a plain link, with sign-out on Account settings only", async () => {
  const gw = fakeGateway({ signedIn: true });
  render(<App />);
  const name = await screen.findByText("Olive Owner");
  fireEvent.click(name);
  expect(screen.queryByRole("button", { name: /Sign out/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Account" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Switch team" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(gw.calls.some((call) => call.path.startsWith("/auth/logout"))).toBe(false);
});

for (const [label, path] of [
  ["Sign out", "/auth/logout"],
  ["Sign out on every device", "/auth/logout-all"],
] as const) {
  it(`"${label}" on Account settings ends the session, closes streams and stays signed out`, async () => {
    const gw = fakeGateway({ signedIn: true, release: "v0.5.1" });
    window.location.hash = "#/account";
    render(<App />);
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    fireEvent.click(await screen.findByRole("button", { name: label }));
    expect(await screen.findByLabelText("Login name")).toBeInTheDocument();
    const logout = gw.calls.filter((call) => call.path.startsWith("/auth/logout"));
    expect(logout).toHaveLength(1);
    expect(logout[0]?.path).toBe(path);
    expect(logout[0]?.method).toBe("POST");
    expect(logout[0]?.headers.get("x-deskmates-csrf")).toBe("session-csrf-1");
    expect(FakeEventSource.instances.every((es) => es.closed)).toBe(true);
    expectNoCredentialStored();
    // A reload asks the Gateway again, which no longer knows this browser.
    cleanup();
    render(<App />);
    expect(await screen.findByLabelText("Login name")).toBeInTheDocument();
    expect(screen.queryByText("Olive Owner")).toBeNull();
  });
}

it("signs out to the sign-in page when the session had already ended", async () => {
  const gw = fakeGateway({ signedIn: true });
  window.location.hash = "#/account";
  render(<App />);
  const button = await screen.findByRole("button", { name: "Sign out" });
  // Revoked elsewhere: the Gateway refuses this browser's CSRF token and cookie.
  gw.state.revoked = true;
  gw.state.csrf = "rotated-elsewhere";
  fireEvent.click(button);
  expect(await screen.findByLabelText("Login name")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("returns to sign-in when a normal API request finds the session revoked", async () => {
  const gw = fakeGateway({ signedIn: true });
  render(<App />);
  await screen.findByText("Olive Owner");
  // Signed out on another device: the Gateway now refuses this browser's cookie.
  gw.state.revoked = true;
  const stream = await waitFor(() => FakeEventSource.forUrl("/api/events?tenant=tnt_default"));
  act(() => {
    stream.drop();
  });
  expect(await screen.findByRole("alert")).toHaveTextContent("session has ended");
  expect(screen.getByLabelText("Login name")).toBeTruthy();
  await waitFor(() => expect(FakeEventSource.instances.every((es) => es.closed)).toBe(true));
});

it("keeps the signed-in UI during a temporary network outage", async () => {
  const gw = fakeGateway({ signedIn: true });
  render(<App />);
  await screen.findByText("Olive Owner");
  const stream = await waitFor(() => FakeEventSource.forUrl("/api/events?tenant=tnt_default"));
  gw.state.offline = true;
  await act(async () => {
    stream.drop();
  });
  expect(screen.getByText("Olive Owner")).toBeTruthy();
  expect(screen.queryByLabelText("Password")).toBeNull();
});

it("identifies an unreachable Gateway at startup and retries", async () => {
  const gw = fakeGateway({ signedIn: true });
  gw.state.offline = true;
  render(<App />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Cannot connect to the server. Check that it is running, then try again.",
  );
  gw.state.offline = false;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByText("Olive Owner");
});

it("shows the running release the Gateway reports, and none when it reports none", async () => {
  fakeGateway({ signedIn: true, release: "v0.4.0" });
  render(<App />);
  expect(await screen.findByLabelText("Running release")).toHaveTextContent("v0.4.0");
  cleanup();
  fakeGateway({ signedIn: true, release: null });
  render(<App />);
  await screen.findByText("Olive Owner");
  expect(screen.queryByLabelText("Running release")).toBeNull();
});
