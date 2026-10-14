// @vitest-environment jsdom
// The current workspace scopes Contacts: only its bots are listed, the switcher changes which,
// and a link to a bot in another workspace switches to that workspace instead of showing a
// contact the list does not hold.

import type { BotDefinition, BotId, Workspace, WorkspaceId } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createApiClient } from "../api/client.js";
import { ContactsScreen } from "../features/contacts/contacts.js";
import { WorkspaceSwitcher } from "../features/workspaces/workspace-switcher.js";
import { WorkspaceScopeProvider, useWorkspaceScope } from "./workspace-scope.js";

afterEach(cleanup);

const ops: Workspace = {
  id: "ws_ops" as WorkspaceId,
  name: "galaxy-ops",
  sandboxProvider: "docker",
  status: "ready",
  egressAllowlist: ["ops.example.test"],
  egressUpdatedAt: "2026-10-01T00:00:00.000Z",
  createdAt: "2026-10-01T00:00:00.000Z",
};
const research: Workspace = { ...ops, id: "ws_research" as WorkspaceId, name: "web-research" };
const makeBot = (name: string, workspaceId: WorkspaceId): BotDefinition => ({
  id: `bot_${name}` as BotId,
  name,
  role: `${name} role`,
  workspaceId,
  soulVersion: 0,
  connectors: [],
  messageAllowlist: [],
  cron: [],
  createdAt: "2026-10-01T00:00:00.000Z",
});
const bots = [makeBot("chief", ops.id), makeBot("qa", ops.id), makeBot("scout", research.id)];

function fakeFetch(): typeof fetch {
  return async (input) => {
    const url = new URL(String(input), "http://gateway.test");
    const body =
      url.pathname === "/api/workspaces"
        ? { workspaces: [ops, research] }
        : url.pathname === "/api/bots" && url.searchParams.has("offset")
          ? (() => {
              const page = bots.filter(
                (bot) => bot.workspaceId === url.searchParams.get("workspaceId"),
              );
              return { bots: page, offset: 0, limit: 50, total: page.length };
            })()
          : url.pathname === "/api/bots"
            ? { bots }
            : url.pathname === "/api/runs" || url.pathname === "/api/runs/latest-by-bot"
              ? { runs: [] }
              : url.pathname === "/api/config"
                ? { defaultModel: "demo", cronTimeZone: "UTC" }
                : {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

function Shell({ botId }: { botId?: string }) {
  const api = createApiClient({ fetch: fakeFetch() });
  return (
    <WorkspaceScopeProvider api={api}>
      <Sidebar api={api} />
      <ContactsScreen api={api} botId={botId} />
    </WorkspaceScopeProvider>
  );
}

function Sidebar({ api }: { api: ReturnType<typeof createApiClient> }) {
  return <WorkspaceSwitcher scope={useWorkspaceScope(api)} />;
}

describe("workspace scope", () => {
  it("lists only the current workspace's bots and switches from the sidebar", async () => {
    window.localStorage.removeItem("deskmates.workspace");
    render(<Shell />);
    await screen.findByRole("heading", { name: "chief" });
    expect(screen.queryByText("scout")).toBeNull();
    expect(screen.getByRole("button", { name: "Workspace: galaxy-ops" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Workspace: galaxy-ops" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /web-research/ }));
    await screen.findByRole("heading", { name: "scout" });
    expect(screen.queryByText("chief")).toBeNull();
    expect(window.localStorage.getItem("deskmates.workspace")).toBe(research.id);
  });

  it("switches workspace when a contact link points into another one", async () => {
    window.localStorage.setItem("deskmates.workspace", ops.id);
    render(<Shell botId="bot_scout" />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Workspace: web-research" })).toBeTruthy(),
    );
    await screen.findByText("scout role");
    expect(screen.queryByText("chief")).toBeNull();
  });
});
