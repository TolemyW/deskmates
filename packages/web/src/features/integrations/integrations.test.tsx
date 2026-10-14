// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import type { IntegrationCatalogEntry } from "@deskmates/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import { SessionRolesProvider } from "../../state/session-roles.js";
import { IntegrationsScreen } from "./integrations.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const workspace = {
  id: "ws_1",
  name: "ops",
  sandboxProvider: "docker",
  egressAllowlist: [],
  createdAt: "2026-09-29T00:00:00.000Z",
};

const connection = {
  id: "icn_1",
  workspaceId: "ws_1",
  service: "slack",
  connectionName: "team",
  runtimeConnectionId: "rt-1",
  authKind: "oauth",
  createdAt: "2026-09-29T00:00:00.000Z",
};

const slackProvider: IntegrationCatalogEntry = {
  service: "slack",
  displayName: "Slack",
  authKinds: ["oauth", "api_key"],
  adopted: true,
};

function gateway(
  configured = true,
  providers = [slackProvider],
  connections: (typeof connection & { revokedAt?: string })[] = [{ ...connection }],
) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (path === "/api/integrations")
      return Response.json({
        configured,
        oauthAvailable: true,
        providers: providers
          .filter((provider) => provider.adopted)
          .map((provider) => ({ ...provider, adoptedAt: "x" })),
      });
    if (path === "/api/integrations/catalog")
      return Response.json({ configured, complete: true, providers });
    if (path === "/api/workspaces") return Response.json({ workspaces: [workspace] });
    if (path === "/api/channels") return Response.json({ plugins: [], failures: [] });
    if (path === "/api/workspaces/ws_1/channels") return Response.json({ connections: [] });
    if (path === "/api/workspaces/ws_1")
      return Response.json({ workspace, bots: [], browserLock: null, takeoverScreen: false });
    if (path.startsWith("/api/integrations/workspaces/ws_1/connections?")) {
      // The Gateway's page: live accounts oldest first, live counts over the whole workspace.
      const q = new URLSearchParams(path.split("?")[1]);
      const live = connections.filter((c) => !c.revokedAt);
      const offset = Number(q.get("offset") ?? 0);
      const limit = Number(q.get("limit") ?? 25);
      const counts = new Map<string, number>();
      for (const c of live) counts.set(c.service, (counts.get(c.service) ?? 0) + 1);
      return Response.json({
        connections: live.slice(offset, offset + limit),
        offset,
        limit,
        total: live.length,
        liveByService: [...counts].map(([service, count]) => ({ service, count })),
      });
    }
    if (path.startsWith("/api/connectors?"))
      return Response.json({ connectors: [], offset: 0, limit: 25, total: 0 });
    if (path.endsWith("/oauth/start"))
      return Response.json({ authorizationUrl: "https://slack.test/authorize?state=s" });
    if (path.endsWith("/api-key")) {
      connections.push({
        ...connection,
        id: "icn_2",
        connectionName: body.connectionName,
        authKind: "api_key",
      });
      return Response.json({ connection: connections.at(-1) }, { status: 201 });
    }
    if (method === "DELETE" && path.includes("/connections/")) {
      const revoked = connections.find((c) => path.endsWith(`/connections/${c.id}`));
      if (revoked) revoked.revokedAt = "y";
      return Response.json({ connection: { ...connection, revokedAt: "y" } });
    }
    if (path === "/api/integrations/providers" && method === "POST")
      return Response.json({ provider: {} }, { status: 201 });
    if (method === "DELETE") return Response.json({ ok: true });
    return Response.json({ code: "not_found", message: "no" }, { status: 404 });
  });
  return { calls, api: createApiClient({ fetch: fetcher }) };
}

it("lists adopted providers and the workspace's connections", async () => {
  const { api } = gateway();
  render(<IntegrationsScreen api={api} />);
  expect(await screen.findByText(/Slack \(slack\)/)).toBeTruthy();
  expect(await screen.findByText(/slack\/team \(oauth\)/)).toBeTruthy();
});

it("opens the authorization URL in a new tab without an opener", async () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const { api, calls } = gateway();
  render(<IntegrationsScreen api={api} />);
  await screen.findByText(/slack\/team \(oauth\)/);
  fireEvent.click(
    within(screen.getByRole("region", { name: "Apps" })).getByRole("button", {
      name: "Add account",
    }),
  );
  fireEvent.change(await screen.findByLabelText("Connection name"), {
    target: { value: "second" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Connect with OAuth" }));
  await waitFor(() => expect(open).toHaveBeenCalled());
  expect(open).toHaveBeenCalledWith(
    "https://slack.test/authorize?state=s",
    "_blank",
    expect.stringContaining("noopener"),
  );
  expect(calls.find((c) => c.path.endsWith("/oauth/start"))?.body).toEqual({
    service: "slack",
    connectionName: "second",
  });
});

it("saves an API key once and clears it from the form", async () => {
  const { api, calls } = gateway();
  render(<IntegrationsScreen api={api} />);
  await screen.findByText(/slack\/team \(oauth\)/);
  const apps = screen.getByRole("region", { name: "Apps" });
  fireEvent.click(within(apps).getByRole("button", { name: "Add account" }));
  fireEvent.change(await screen.findByLabelText("Connection name"), {
    target: { value: "bot" },
  });
  fireEvent.change(screen.getByLabelText("API key"), { target: { value: "xoxb-secret" } });
  fireEvent.click(screen.getByRole("button", { name: "Save API key" }));
  expect(await screen.findByText(/slack\/bot \(api_key\)/)).toBeTruthy();
  expect(calls.find((c) => c.path.endsWith("/api-key"))?.body).toEqual({
    service: "slack",
    connectionName: "bot",
    apiKey: "xoxb-secret",
  });
  // The dialog closed with the key; reopening it never shows the key again.
  fireEvent.click(within(apps).getByRole("button", { name: "Add account" }));
  expect(((await screen.findByLabelText("API key")) as HTMLInputElement).value).toBe("");
});

it("revokes a connection and unadopts a provider", async () => {
  const { api, calls } = gateway();
  render(<IntegrationsScreen api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: "Revoke slack/team" }));
  await waitFor(() =>
    expect(calls.some((c) => c.method === "DELETE" && c.path.endsWith("/connections/icn_1"))).toBe(
      true,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Unadopt slack" }));
  await waitFor(() =>
    expect(
      calls.some((c) => c.method === "DELETE" && c.path === "/api/integrations/providers/slack"),
    ).toBe(true),
  );
});

it("says so when no runtime is configured", async () => {
  const { api } = gateway(false);
  render(<IntegrationsScreen api={api} />);
  expect(await screen.findByText(/No integration runtime is configured/)).toBeTruthy();
});

it("features only capabilities reported by the live catalog and uses release-local logos", async () => {
  const { api } = gateway(true, [
    slackProvider,
    {
      service: "github",
      displayName: "GitHub",
      authKinds: ["oauth"],
      adopted: false,
    },
  ]);
  render(<IntegrationsScreen api={api} />);
  const featured = await screen.findByRole("region", { name: "Featured integrations" });
  expect(within(featured).getByText("Slack")).toBeTruthy();
  expect(within(featured).getByText("GitHub")).toBeTruthy();
  expect(within(featured).queryByText("Notion")).toBeNull();
  expect(screen.queryByText(/coming soon/i)).toBeNull();
  expect(featured.querySelector('img[src="/integration-logos/github.svg"]')).toBeTruthy();
});

it("searches, categorizes and pages the complete live catalog", async () => {
  const providers: IntegrationCatalogEntry[] = Array.from({ length: 30 }, (_, index) => ({
    service: `service-${index}`,
    displayName: `Provider ${index}`,
    authKinds: ["api_key"],
    adopted: false,
  }));
  providers.push({
    service: "github",
    displayName: "GitHub",
    authKinds: ["oauth"],
    adopted: false,
  });
  const { api } = gateway(true, providers);
  render(<IntegrationsScreen api={api} />);

  expect(await screen.findByText("Provider 0 (service-0)")).toBeTruthy();
  expect(screen.queryByText("Provider 29 (service-29)")).toBeNull();
  const catalogPages = screen.getByRole("navigation", { name: "Integration catalog pages" });
  expect(catalogPages).toHaveTextContent("1–24 of 31");
  fireEvent.click(within(catalogPages).getByRole("button", { name: "Next" }));
  expect(await screen.findByText("Provider 29 (service-29)")).toBeTruthy();
  expect(catalogPages).toHaveTextContent("25–31 of 31");

  fireEvent.change(screen.getByRole("searchbox", { name: "Search integrations" }), {
    target: { value: "service-29" },
  });
  expect(await screen.findByText("Provider 29 (service-29)")).toBeTruthy();
  expect(screen.queryByText("Provider 0 (service-0)")).toBeNull();

  fireEvent.change(screen.getByRole("searchbox", { name: "Search integrations" }), {
    target: { value: "" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Code" }));
  expect(await screen.findByText("GitHub (github)")).toBeTruthy();
  expect(screen.queryByText("Provider 0 (service-0)")).toBeNull();
});

it("pages connected accounts, counts them from the aggregate, and clamps after a revoke (#113)", async () => {
  // 51 Slack accounts: three pages of 25. The card's count is the workspace's, not the page's.
  const many = Array.from({ length: 51 }, (_, i) => ({
    ...connection,
    id: `icn_${String(i).padStart(2, "0")}`,
    connectionName: `team-${String(i).padStart(2, "0")}`,
  }));
  const { api, calls } = gateway(true, [slackProvider], many);
  render(<IntegrationsScreen api={api} />);
  const pages = await screen.findByRole("navigation", { name: "Connected account pages" });
  await waitFor(() => expect(pages).toHaveTextContent("1–25 of 51"));
  const apps = screen.getByRole("region", { name: "Apps" });
  expect(within(apps).getByText("51 connected")).toBeTruthy();
  fireEvent.click(within(pages).getByRole("button", { name: "Next" }));
  await waitFor(() => expect(pages).toHaveTextContent("26–50 of 51"));
  fireEvent.click(within(pages).getByRole("button", { name: "Next" }));
  await waitFor(() => expect(pages).toHaveTextContent("51–51 of 51"));
  expect(within(pages).getByRole("button", { name: "Next" })).toBeDisabled();
  expect(calls.some((c) => c.path.endsWith("/connections?status=live&offset=50&limit=25"))).toBe(
    true,
  );
  // Back returns to the page before, as a history entry.
  act(() => window.history.back());
  await waitFor(() => expect(pages).toHaveTextContent("26–50 of 51"));
  act(() => window.history.forward());
  await waitFor(() => expect(pages).toHaveTextContent("51–51 of 51"));
  // Revoking the only account of the last page steps back to the page that has rows.
  fireEvent.click(screen.getByRole("button", { name: "Revoke slack/team-50" }));
  await waitFor(() => expect(pages).toHaveTextContent("26–50 of 50"));
  expect(within(apps).getByText("50 connected")).toBeTruthy();
});

it("shows role-aware state without offering unavailable actions", async () => {
  const { api } = gateway(true, [
    {
      service: "github",
      displayName: "GitHub",
      authKinds: ["oauth"],
      adopted: false,
    },
  ]);
  render(
    <SessionRolesProvider roles={{ tenantRole: "member", platformMaintainer: false }}>
      <IntegrationsScreen api={api} />
    </SessionRolesProvider>,
  );
  const featured = await screen.findByRole("region", { name: "Featured integrations" });
  expect(within(featured).getAllByText("Needs admin").length).toBeGreaterThan(0);
  expect(within(featured).queryByRole("button", { name: "Adopt" })).toBeNull();
});
