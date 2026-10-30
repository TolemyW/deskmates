// @vitest-environment jsdom
// T0: the forced password change (ADR-0022 amendment 6 W2, issue #21). While `GET /auth/session` reports
// `passwordChangeRequired`, the app shows the change-password screen instead of the shell and
// sends no `/api` request; after `POST /auth/password` it reads the session again and enters.
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installFakeEventSource } from "../test-support/fixtures.js";
import { App } from "./bootstrap.js";

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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeGateway(root = true) {
  const state = { required: true, csrf: "csrf-1" };
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const view = () => ({
    authenticated: true,
    user: root
      ? { id: "usr_root", displayName: "Administrator", loginName: "admin" }
      : { id: "usr_member", displayName: "New Member", loginName: "new-member" },
    tenant: { id: "tnt_default", name: "Default Tenant", role: "owner" },
    session: {
      authenticatedAt: "2026-10-13T00:00:00.000Z",
      idleExpiresAt: "2026-10-20T00:00:00.000Z",
      absoluteExpiresAt: "2026-11-12T00:00:00.000Z",
    },
    csrfToken: state.csrf,
    ...(root ? { root: true } : {}),
    workspaceRoles: [],
    passwordChangeRequired: state.required,
  });
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (path === "/auth/session") return json(view());
    if (path === "/auth/password" && method === "POST") {
      if (body?.currentPassword !== "admin")
        return json({ code: "forbidden", message: "Current password is incorrect" }, 403);
      state.required = false;
      state.csrf = "csrf-2";
      return json(view());
    }
    if (path.startsWith("/api/")) {
      if (state.required)
        return json(
          {
            code: "forbidden",
            message: "Change the password first",
            details: { reason: "password_change_required" },
          },
          403,
        );
      if (path.startsWith("/api/config")) return json({ release: null });
      if (path.startsWith("/api/workspaces")) return json({ workspaces: [] });
      if (path.startsWith("/api/bots")) return json({ bots: [] });
      if (path.startsWith("/api/threads")) return json({ threads: [] });
      return json({ approvals: [], runs: [], alerts: [] });
    }
    return json({ code: "not_found", message: path }, 404);
  });
  vi.stubGlobal("fetch", fetch);
  return { calls, state };
}

it("redirects an administrator-created account to change its initial password", async () => {
  const gateway = fakeGateway(false);
  render(<App />);
  expect(await screen.findByTestId("password-change")).toBeInTheDocument();
  expect(screen.getByLabelText("Current password")).toBeInTheDocument();
  expect(screen.getByLabelText("New password")).toBeInTheDocument();
  expect(screen.getByLabelText("Confirm new password")).toBeInTheDocument();
  // No shell: none of its navigation, and no `/api` request at all.
  expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(gateway.calls.filter((call) => call.path.startsWith("/api/"))).toEqual([]);
});

it("refuses mismatched passwords locally, then changes the password and enters the app", async () => {
  const gateway = fakeGateway();
  render(<App />);
  await screen.findByTestId("password-change");
  fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "admin" } });
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: "a new secret" } });
  fireEvent.change(screen.getByLabelText("Confirm new password"), {
    target: { value: "another secret" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Change password" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("The new passwords do not match.");
  expect(gateway.calls.some((call) => call.path === "/auth/password")).toBe(false);

  fireEvent.change(screen.getByLabelText("Confirm new password"), {
    target: { value: "a new secret" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Change password" }));
  await waitFor(() => expect(screen.queryByTestId("password-change")).not.toBeInTheDocument());
  const change = gateway.calls.find((call) => call.path === "/auth/password");
  expect(change?.body).toEqual({ currentPassword: "admin", newPassword: "a new secret" });
  // The session was read again, and only then did the app ask the Gateway's `/api`.
  const changedAt = gateway.calls.indexOf(change as (typeof gateway.calls)[number]);
  await waitFor(() =>
    expect(gateway.calls.slice(changedAt).some((call) => call.path.startsWith("/api/"))).toBe(true),
  );
  expect(gateway.calls.slice(0, changedAt).some((call) => call.path.startsWith("/api/"))).toBe(
    false,
  );
});
