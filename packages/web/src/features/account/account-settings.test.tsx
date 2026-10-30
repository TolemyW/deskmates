// @vitest-environment jsdom
// Account settings (ADR-0022 amendment 3, issue #26) through the whole app: reachable from the
// signed-in identity, profile and photo saves update every identity surface, password change
// adopts the rotated session's CSRF token, and SSO-managed accounts get an explanation instead
// of a form. No password reaches browser storage or the address bar.
import "@testing-library/jest-dom/vitest";
import type { AccountView } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../../app.js";
import { FakeEventSource, installFakeEventSource } from "../../test-support/fixtures.js";

const CURRENT = "current password 1";
const NEXT = "brand new password 2";

beforeEach(() => {
  window.location.hash = "#/account";
  installFakeEventSource();
});
const restore: Array<() => void> = [];
afterEach(() => {
  for (const undo of restore.splice(0)) undo();
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Call {
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
  status?: number;
}

function fakeGateway(
  account: AccountView = { localLoginName: "olive", password: "available" },
  role: "owner" | "admin" | "member" = "member",
  root = false,
) {
  const state = {
    csrf: "csrf-1",
    displayName: "Olive Owner",
    avatarUrl: null as string | null,
    password: CURRENT,
    profileStatus: undefined as number | undefined,
    /** Holds the password response, as a slow network would; old-session requests get 401. */
    holdPassword: undefined as Promise<void> | undefined,
    rotating: false,
    /** Service principals created through "Connect an agent", with the status to answer. */
    principals: [] as Array<{ name: string }>,
    principalStatus: undefined as number | undefined,
  };
  const calls: Call[] = [];
  const view = () => ({
    authenticated: true,
    root,
    user: {
      id: "usr_1",
      displayName: state.displayName,
      loginName: account.password === "available" ? "olive" : null,
      avatarUrl: state.avatarUrl,
    },
    tenant: { id: "tnt_default", name: "Default Tenant", role },
    session: {
      authenticatedAt: "2026-10-10T00:00:00.000Z",
      idleExpiresAt: "2026-10-17T00:00:00.000Z",
      absoluteExpiresAt: "2026-11-09T00:00:00.000Z",
    },
    csrfToken: state.csrf,
    account,
  });
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    const call: Call = { method, path, headers, body };
    calls.push(call);
    const response = await respond(path, method, headers, body);
    call.status = response.status;
    return response;
  });
  const respond = async (
    path: string,
    method: string,
    headers: Headers,
    body: unknown,
  ): Promise<Response> => {
    if (state.rotating && path.startsWith("/api/"))
      return json({ code: "token_rejected", message: "not signed in" }, 401);
    if (path === "/auth/session") {
      // A real network round trip, so a sign-in check renders its loading state in between.
      if (state.holdPassword) await new Promise((resolve) => setTimeout(resolve, 20));
      return json(view());
    }
    if (method !== "GET" && headers.get("x-deskmates-csrf") !== state.csrf)
      return json({ code: "forbidden", message: "csrf", details: { reason: "csrf" } }, 403);
    if (path === "/auth/profile" && method === "PATCH") {
      if (state.profileStatus)
        return json({ code: "internal", message: "down", details: {} }, state.profileStatus);
      state.displayName = (body as { displayName: string }).displayName;
      return json({ displayName: state.displayName, avatarUrl: state.avatarUrl });
    }
    if (path === "/auth/avatar" && method === "PUT") {
      state.avatarUrl = "/auth/avatar?v=0123456789abcdef";
      return json({ displayName: state.displayName, avatarUrl: state.avatarUrl });
    }
    if (path === "/auth/avatar" && method === "DELETE") {
      state.avatarUrl = null;
      return json({ displayName: state.displayName, avatarUrl: null });
    }
    if (path === "/auth/password" && method === "POST") {
      const change = body as { currentPassword: string; newPassword: string };
      if (change.currentPassword !== state.password)
        return json({ code: "forbidden", message: "Current password is incorrect" }, 403);
      state.password = change.newPassword;
      if (state.holdPassword) {
        state.rotating = true;
        await state.holdPassword;
        state.rotating = false;
      }
      state.csrf = "csrf-2";
      return json(view());
    }
    if (path === "/api/service-principals" && method === "POST") {
      if (state.principalStatus)
        return json({ code: "internal", message: "down", details: {} }, state.principalStatus);
      const created = body as { name: string };
      state.principals.push(created);
      return json(
        {
          servicePrincipal: {
            id: `sp_${state.principals.length}`,
            tenantId: "tnt_default",
            name: created.name,
            role: "admin",
            status: "active",
            dailyUsdCap: 5,
            createdAt: "2026-10-10T00:00:00.000Z",
          },
          token: `deskmates-sp.secret-${state.principals.length}`,
        },
        201,
      );
    }
    if (path === "/api/config") return json({ defaultModel: "m", cheapModel: "c", release: null });
    if (path.startsWith("/api/workspaces")) return json({ workspaces: [] });
    if (path.startsWith("/api/bots")) return json({ bots: [] });
    if (path.startsWith("/api/threads")) return json({ threads: [] });
    return json({ approvals: [] });
  };
  vi.stubGlobal("fetch", fetch);
  return { state, calls };
}

function expectNoSecretStored(): void {
  expect(window.localStorage.length).toBe(0);
  expect(window.sessionStorage.length).toBe(0);
  expect(window.location.href).not.toMatch(/password|csrf/i);
}

it("is reached from the signed-in identity, which links to it in every sidebar layout", async () => {
  fakeGateway();
  window.location.hash = "#/threads";
  render(<App />);
  const link = await screen.findByRole("link", {
    name: "Account settings for Olive Owner",
  });
  expect(link).toHaveAttribute("href", "#/account");
  window.location.hash = "#/account";
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  expect(await screen.findByRole("heading", { name: "Account settings" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Account settings for Olive Owner" })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

async function editName() {
  fireEvent.click(await screen.findByRole("button", { name: "Change display name" }));
  return screen.getByLabelText("Display name");
}
async function editPassword() {
  fireEvent.click(await screen.findByRole("button", { name: "Change password" }));
  return screen.getByLabelText("Current password");
}

it("opens editors explicitly, restores focus on cancel and discards unsaved names and passwords", async () => {
  const gw = fakeGateway();
  render(<App />);
  await screen.findByRole("button", { name: "Change display name" });
  expect(screen.queryByLabelText("Display name")).toBeNull();
  expect(screen.queryByLabelText("Current password")).toBeNull();
  const name = await editName();
  expect(name).toHaveFocus();
  fireEvent.change(name, { target: { value: "Discard this draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("button", { name: "Change display name" })).toHaveFocus();
  expect(await editName()).toHaveValue("Olive Owner");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

  const current = await editPassword();
  expect(current).toHaveFocus();
  fireEvent.change(current, { target: { value: CURRENT } });
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: NEXT } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("button", { name: "Change password" })).toHaveFocus();
  expect(screen.queryByLabelText("Current password")).toBeNull();
  expect(await editPassword()).toHaveValue("");
  expect(screen.getByLabelText("New password")).toHaveValue("");
  expect(screen.getByLabelText("Confirm new password")).toHaveValue("");
  expect(
    gw.calls.some((call) => call.path === "/auth/profile" || call.path === "/auth/password"),
  ).toBe(false);
  expectNoSecretStored();
});

for (const role of ["owner", "admin", "member"] as const) {
  it(`gives a ${role} three settings pages with explicit account editors and separate preferences`, async () => {
    fakeGateway(undefined, role);
    render(<App />);
    await screen.findByRole("heading", { name: "Account settings" });
    const sections = screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);
    expect(sections).toEqual(["Profile", "Password", "Sign out"]);
    // ADR-0034 decision 7: Personal settings, Agent access and Workspaces, each an address.
    const pages = screen.getByRole("navigation", { name: "Settings pages" });
    expect(
      within(pages)
        .getAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("href")]),
    ).toEqual([
      ["Personal settings", "#/account"],
      ["Agent access", "#/account/agent-access"],
      ["Workspaces", "#/account/workspaces"],
    ]);
    expect(within(pages).getByRole("link", { name: "Personal settings" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    fireEvent.click(screen.getByRole("button", { name: "Preferences" }));
    const preferences = screen.getByRole("region", { name: "Preferences" });
    expect(within(preferences).getByLabelText("Language")).toBeInTheDocument();
    expect(within(preferences).getByLabelText("Appearance")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close preferences" }));
    const signOut = screen.getByRole("region", { name: "Sign out" });
    expect(within(signOut).getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(
      within(signOut).getByRole("button", { name: "Sign out on every device" }),
    ).toBeInTheDocument();
  });
}

it("saves the display name and updates the identity without touching the login name", async () => {
  const gw = fakeGateway();
  render(<App />);
  const field = await editName();
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  fireEvent.change(field, { target: { value: "  " } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("Enter a display name.")).toBeInTheDocument();
  expect(gw.calls.some((call) => call.path === "/auth/profile")).toBe(false);

  // A recoverable failure keeps the edit.
  gw.state.profileStatus = 503;
  fireEvent.change(field, { target: { value: "Olive O." } });
  expect(screen.getByText("Unsaved changes.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText(/Could not save/)).toBeInTheDocument();
  expect(field).toHaveValue("Olive O.");

  gw.state.profileStatus = undefined;
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("Display name saved.")).toBeInTheDocument();
  const save = gw.calls.filter((call) => call.path === "/auth/profile").at(-1);
  expect(save?.body).toEqual({ displayName: "Olive O." });
  expect(save?.headers.get("x-deskmates-csrf")).toBe("csrf-1");
  expect(screen.getByRole("link", { name: "Account settings for Olive O." })).toBeInTheDocument();
  const facts = screen.getByText("Login name").closest("div") as HTMLElement;
  expect(within(facts).getByText("olive")).toBeInTheDocument();
});

it("previews, uploads and removes a photo, and rejects an unsupported file before upload", async () => {
  const gw = fakeGateway();
  // jsdom has no object URLs; the preview needs one.
  const original = URL.createObjectURL;
  URL.createObjectURL = () => "blob:preview";
  restore.push(() => {
    URL.createObjectURL = original;
  });
  render(<App />);
  const input = (await screen.findByLabelText("Photo file")) as HTMLInputElement;
  expect(screen.queryByRole("button", { name: "Remove photo" })).toBeNull();

  const gif = new File(["GIF89a"], "cat.gif", { type: "image/gif" });
  fireEvent.change(input, { target: { files: [gif] } });
  expect(await screen.findByText(/Choose a PNG, JPEG or WebP image/)).toBeInTheDocument();
  expect(gw.calls.some((call) => call.path === "/auth/avatar")).toBe(false);

  const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "me.png", {
    type: "image/png",
  });
  fireEvent.change(input, { target: { files: [png] } });
  expect(await screen.findByRole("button", { name: "Save photo" })).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "Discard photo" }));
  expect(screen.getByRole("button", { name: "Change photo" })).toHaveFocus();
  expect(gw.calls.some((call) => call.path === "/auth/avatar")).toBe(false);
  fireEvent.change(input, { target: { files: [png] } });
  expect(await screen.findByRole("button", { name: "Save photo" })).toHaveFocus();
  expect(document.querySelector(".account-photo img")).toHaveAttribute("src", "blob:preview");
  fireEvent.click(screen.getByRole("button", { name: "Save photo" }));
  expect(await screen.findByText("Photo saved.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Change photo" })).toHaveFocus();
  const upload = gw.calls.find((call) => call.path === "/auth/avatar" && call.method === "PUT");
  expect(upload?.headers.get("content-type")).toBe("image/png");
  // The sidebar identity shows the stored photo.
  const identity = screen.getByRole("link", {
    name: "Account settings for Olive Owner",
  });
  expect(identity.querySelector("img")).toHaveAttribute("src", "/auth/avatar?v=0123456789abcdef");

  fireEvent.click(screen.getByRole("button", { name: "Remove photo" }));
  expect(await screen.findByText(/Photo removed/)).toBeInTheDocument();
  expect(identity.querySelector("img")).toBeNull();
});

it("changes the password, adopts the rotated session and clears the fields", async () => {
  const gw = fakeGateway();
  render(<App />);
  const current = await editPassword();
  const next = screen.getByLabelText("New password");
  const confirm = screen.getByLabelText("Confirm new password");
  expect(current).toHaveAttribute("autocomplete", "current-password");
  expect(next).toHaveAttribute("autocomplete", "new-password");
  expect(next).toHaveAttribute("type", "password");
  fireEvent.click(screen.getByRole("button", { name: "Show New password" }));
  expect(next).toHaveAttribute("type", "text");

  fireEvent.change(current, { target: { value: CURRENT } });
  fireEvent.change(next, { target: { value: NEXT } });
  fireEvent.change(confirm, { target: { value: NEXT } });
  fireEvent.click(screen.getByRole("button", { name: "Save password" }));
  expect(await screen.findByText(/Password changed/)).toBeInTheDocument();
  expect(screen.queryByLabelText("Current password")).toBeNull();
  await editPassword();
  expect(screen.getByLabelText("Current password")).toHaveValue("");
  expect(screen.getByLabelText("New password")).toHaveValue("");
  expect(screen.getByLabelText("Confirm new password")).toHaveValue("");
  const change = gw.calls.find((call) => call.path === "/auth/password");
  expect(change?.headers.get("x-deskmates-csrf")).toBe("csrf-1");
  expect(change?.body).toEqual({ currentPassword: CURRENT, newPassword: NEXT });

  // The next mutation carries the rotated session's token.
  fireEvent.change(await editName(), { target: { value: "Olive Two" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Display name saved.");
  const after = gw.calls.filter((call) => call.path === "/auth/profile").at(-1);
  expect(after?.headers.get("x-deskmates-csrf")).toBe("csrf-2");
  expectNoSecretStored();
});

it("is not signed out by a 401 its own password change causes", async () => {
  // The Gateway revokes the old session, closing this tab's streams, before the response with the
  // rotated cookie arrives; a request in that window gets 401.
  const gw = fakeGateway();
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  gw.state.holdPassword = held;
  render(<App />);
  fireEvent.change(await editPassword(), {
    target: { value: CURRENT },
  });
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: NEXT } });
  fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: NEXT } });
  // The same form element throughout: the tab never unmounts for a sign-in check.
  const form = screen.getByLabelText("Current password");
  fireEvent.click(screen.getByRole("button", { name: "Save password" }));
  await waitFor(() => expect(gw.state.rotating).toBe(true));
  await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
  for (const stream of [...FakeEventSource.instances]) stream.fail();
  await waitFor(() =>
    expect(gw.calls.some((call) => call.path === "/api/config" && call.status === 401)).toBe(true),
  );
  expect(form.isConnected).toBe(true);
  release();
  expect(await screen.findByText(/Password changed/)).toBeInTheDocument();
  expect(form.isConnected).toBe(false);
  expect(screen.queryByLabelText("Current password")).toBeNull();
  expect(screen.getByRole("heading", { name: "Account settings" })).toBeInTheDocument();
  expect(screen.queryByLabelText("Login name")).toBeNull();
});

it("shows mismatch and wrong-password errors without sending or keeping the passwords", async () => {
  const gw = fakeGateway();
  render(<App />);
  fireEvent.change(await editPassword(), {
    target: { value: "wrong password here" },
  });
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: NEXT } });
  fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "other" } });
  fireEvent.click(screen.getByRole("button", { name: "Save password" }));
  expect(await screen.findByText("The new passwords do not match.")).toBeInTheDocument();
  expect(gw.calls.some((call) => call.path === "/auth/password")).toBe(false);

  fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: NEXT } });
  fireEvent.click(screen.getByRole("button", { name: "Save password" }));
  expect(await screen.findByText("Your current password is incorrect.")).toBeInTheDocument();
  expect(screen.getByLabelText("Current password")).toHaveValue("");
  expect(screen.getByLabelText("Current password")).toHaveAttribute("aria-invalid", "true");
  // Still signed in: a wrong password is not a lost session.
  expect(screen.getByRole("heading", { name: "Account settings" })).toBeInTheDocument();
  expectNoSecretStored();
});

it("explains SSO-managed passwords instead of a form", async () => {
  fakeGateway({ localLoginName: null, password: "identity_provider" });
  render(<App />);
  expect(await screen.findByText(/managed by your identity provider/)).toBeInTheDocument();
  expect(screen.queryByLabelText("Current password")).toBeNull();
  expect(screen.getByText("None (you sign in with single sign-on)")).toBeInTheDocument();
});

it("tells a mixed account signed in through SSO to sign in with its password", async () => {
  fakeGateway({ localLoginName: "olive", password: "sign_in_with_password" });
  render(<App />);
  expect(
    await screen.findByText(/also has a Deskmates password for the login name olive/),
  ).toBeInTheDocument();
  expect(screen.queryByLabelText("Current password")).toBeNull();
});

/** The clipboard as a browser offers it after a click; jsdom has none. */
function fakeClipboard(result: "ok" | "fail" = "ok") {
  const writeText = vi.fn(async (_text: string) => {
    if (result === "fail") throw new Error("denied");
  });
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  return writeText;
}

it("keeps the issued token separate from the copied skill-installation prompt", async () => {
  window.location.hash = "#/account/agent-access";
  const gw = fakeGateway(undefined, "admin", true);
  const writeText = fakeClipboard();
  render(<App />);
  expect(await screen.findByRole("heading", { name: "Connect an agent" })).toBeInTheDocument();
  // The installation prompt never carries a token, before or after issuance.
  const promptBox = screen.getByLabelText("Prompt for your agent");
  expect(promptBox).toHaveTextContent(`${window.location.origin}/agent-skill/SKILL.md`);
  expect(promptBox.textContent).not.toContain("DESKMATES_TOKEN=");
  expect(promptBox.textContent).not.toContain("deskmates-sp.");

  fireEvent.click(screen.getByRole("button", { name: "Create agent key" }));
  expect(await screen.findByText(/not included in the agent prompt/)).toBeInTheDocument();
  const create = gw.calls.find((call) => call.path === "/api/service-principals");
  expect(create?.method).toBe("POST");
  expect(create?.body).toEqual({ name: "Olive Owner's agent" });
  expect(create?.headers.get("x-deskmates-csrf")).toBe("csrf-1");
  expect(screen.getByLabelText("One-time agent key")).toHaveTextContent("deskmates-sp.secret-1");
  expect(promptBox.textContent).not.toContain("DESKMATES_TOKEN=");
  expect(promptBox.textContent).not.toContain("deskmates-sp.");
  // One token per visit: the button is gone once the token is shown separately.
  expect(screen.queryByRole("button", { name: "Create agent key" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Copy key" }));
  expect(await screen.findByText(/Key copied/)).toBeInTheDocument();
  expect(writeText).toHaveBeenNthCalledWith(1, "deskmates-sp.secret-1");

  fireEvent.click(screen.getByRole("button", { name: "Copy prompt" }));
  expect(await screen.findByText("Copied.")).toBeInTheDocument();
  expect(writeText).toHaveBeenCalledTimes(2);
  const copied = writeText.mock.calls[1]?.[0] ?? "";
  expect(copied).not.toContain("DESKMATES_TOKEN=");
  expect(copied).not.toContain("deskmates-sp.");
  expect(copied).toContain("~/.claude/skills/deskmates/SKILL.md");
  expect(copied).toContain("~/.config/deskmates/credentials");
  expect(copied).toContain("TLS certificate verification enabled");
  expectNoSecretStored();
  expect(window.location.href).not.toContain("deskmates-sp");
});

it("reports a token the Gateway would not create and a copy the browser refused", async () => {
  window.location.hash = "#/account/agent-access";
  const gw = fakeGateway(undefined, "owner", true);
  fakeClipboard("fail");
  gw.state.principalStatus = 503;
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Create agent key" }));
  expect(await screen.findByText("Could not create the key. Try again.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Create agent key" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Copy prompt" }));
  expect(await screen.findByText(/Could not copy/)).toBeInTheDocument();
});

it.each(["owner", "admin", "member"] as const)(
  "gives a non-root %s an installation prompt without key creation",
  async (role) => {
    window.location.hash = "#/account/agent-access";
    const gw = fakeGateway(undefined, role);
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Connect an agent" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create agent key" })).toBeNull();
    expect(screen.getByText(/Creating a key requires the root account/)).toBeInTheDocument();
    const prompt = screen.getByLabelText("Prompt for your agent").textContent ?? "";
    expect(prompt).not.toContain("DESKMATES_TOKEN=");
    expect(prompt).not.toContain("deskmates-sp.");
    expect(prompt).toContain("credentials are not enrolled");
    expect(gw.calls.some((call) => call.path === "/api/service-principals")).toBe(false);
  },
);
