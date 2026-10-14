// @vitest-environment jsdom
// Issue #27 phase A: Operate › Computer holds the shared computer's infrastructure settings:
// what bots in the workspace share, allowed domains, and the bots whose screens and takeover
// controls live on their profiles. Opening the page only reads; it never starts a workspace,
// takes control or changes an allowlist.
import "@testing-library/jest-dom/vitest";
import type { SessionRoles, Workspace } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import { SessionRolesProvider } from "../../state/session-roles.js";
import { bot, fakeFetch, installFakeEventSource, workspace } from "../../test-support/fixtures.js";
import { ComputerScreen } from "./computer.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const ADMIN: SessionRoles = { tenantRole: "admin", platformMaintainer: false };
const MEMBER: SessionRoles = { tenantRole: "member", platformMaintainer: false };

function renderComputer(roles: SessionRoles, workspaces: Workspace[]) {
  installFakeEventSource();
  const gateway = fakeFetch({
    "GET /api/workspaces": { workspaces },
    // #113 slice D: one page of the workspace's bots with the Gateway's total.
    "GET /api/bots?workspaceId=ws_1&offset=0&limit=25": {
      bots: [bot, { ...bot, id: "bot_2", name: "a-very-long-bot-name-x" }],
      offset: 0,
      limit: 25,
      total: 2,
    },
  });
  render(
    <SessionRolesProvider roles={roles}>
      <ComputerScreen api={createApiClient({ fetch: gateway.fetch })} />
    </SessionRolesProvider>,
  );
  return gateway;
}

it("shows the shared computer's settings and links to bot desktops without changing anything", async () => {
  const gateway = renderComputer(ADMIN, [workspace]);
  expect(await screen.findByRole("heading", { level: 1, name: "Computer" })).toBeInTheDocument();
  expect(await screen.findByText("2 bots")).toBeInTheDocument();
  expect(screen.getByText("1 allowed domain")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Allowed domains" })).toBeInTheDocument();
  expect(
    screen.getByText(/Bots here share browser logins and files/, { exact: false }),
  ).toBeInTheDocument();
  const desktops = screen.getByRole("region", { name: "Bots and desktops" });
  const links = within(desktops).getAllByRole("link", { name: /Open desktop/ });
  expect(links.map((link) => link.getAttribute("href"))).toEqual([
    "#/contacts/bot_1",
    "#/contacts/bot_2",
  ]);
  await waitFor(() => expect(gateway.calls.length).toBeGreaterThan(1));
  expect(gateway.calls.every((call) => call.method === "GET")).toBe(true);
  expect(gateway.calls.some((call) => /start|takeover|lock|egress/.test(call.path))).toBe(false);
  // Only this workspace's page is read, never every bot of the tenant.
  expect(gateway.calls.some((call) => call.path === "/api/bots")).toBe(false);
});

it("counts the workspace's bots from the Gateway total and pages the desktops", async () => {
  installFakeEventSource();
  const many = Array.from({ length: 25 }, (_, i) => ({
    ...bot,
    id: `bot_${i}`,
    name: `agent-${String(i).padStart(2, "0")}`,
  }));
  const gateway = fakeFetch({
    "GET /api/workspaces": { workspaces: [workspace] },
    "GET /api/bots?workspaceId=ws_1&offset=0&limit=25": {
      bots: many,
      offset: 0,
      limit: 25,
      total: 30,
    },
    "GET /api/bots?workspaceId=ws_1&offset=25&limit=25": {
      bots: [{ ...bot, id: "bot_last", name: "last-bot" }],
      offset: 25,
      limit: 25,
      total: 30,
    },
  });
  render(
    <SessionRolesProvider roles={ADMIN}>
      <ComputerScreen api={createApiClient({ fetch: gateway.fetch })} />
    </SessionRolesProvider>,
  );
  expect(await screen.findByText("30 bots")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(await screen.findByText("last-bot")).toBeInTheDocument();
});

it("offers New workspace when there is none, disabled for a Member", async () => {
  renderComputer(MEMBER, []);
  expect(await screen.findByRole("button", { name: "New workspace" })).toBeDisabled();
});
