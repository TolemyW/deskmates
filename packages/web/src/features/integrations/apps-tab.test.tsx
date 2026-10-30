// @vitest-environment jsdom
// T0: Connections › Apps, built for a large catalog (docs/design/connections-redesign-2026-10-22.md,
// "Apps at scale"): what is in use first, a search over everything, then only apps that can be
// connected here, featured first, a page of 24 at a time.
import "@testing-library/jest-dom/vitest";

import type { IntegrationCatalogEntry } from "@deskmates/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import { SessionRolesProvider } from "../../state/session-roles.js";
import { APPS_SHOWN_STEP, AppsTab, listedApps } from "./apps-tab.js";

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

const apps = (api: ReturnType<typeof createApiClient>) => (
  <AppsTab api={api} workspaceId={workspace.id} />
);

/** The connected accounts sit behind a disclosure under "In use". */
async function openAccounts() {
  const summary = await screen.findByText("Connected accounts");
  (summary.closest("details") as HTMLDetailsElement).open = true;
}

const search = (value: string) =>
  fireEvent.change(screen.getByRole("searchbox", { name: "Search all apps" }), {
    target: { value },
  });

it("shows what is in use first, with its accounts", async () => {
  const { api } = gateway();
  render(apps(api));
  const inUse = await screen.findByRole("region", { name: "In use" });
  expect(within(inUse).getByText("Slack")).toBeTruthy();
  expect(await within(inUse).findByText("1 connected")).toBeTruthy();
  expect(within(inUse).getByText(/Reading runs without asking/)).toBeTruthy();
  await openAccounts();
  expect(within(inUse).getByText("slack/team")).toBeTruthy();
});

it("opens the authorization URL in a new tab without an opener", async () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const { api, calls } = gateway();
  render(apps(api));
  fireEvent.click(await screen.findByRole("button", { name: "Add another Slack account" }));
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
  render(apps(api));
  const add = await screen.findByRole("button", { name: "Add another Slack account" });
  fireEvent.click(add);
  fireEvent.change(await screen.findByLabelText("Connection name"), {
    target: { value: "bot" },
  });
  fireEvent.change(screen.getByLabelText("API key"), { target: { value: "xoxb-secret" } });
  fireEvent.click(screen.getByRole("button", { name: "Save API key" }));
  await openAccounts();
  expect(await screen.findByText("slack/bot")).toBeTruthy();
  expect(calls.find((c) => c.path.endsWith("/api-key"))?.body).toEqual({
    service: "slack",
    connectionName: "bot",
    apiKey: "xoxb-secret",
  });
  // The dialog closed with the key; reopening it never shows the key again.
  fireEvent.click(screen.getByRole("button", { name: "Add another Slack account" }));
  expect(((await screen.findByLabelText("API key")) as HTMLInputElement).value).toBe("");
});

it("revokes a connection and, in the Tune view, lets the maintainer disable an app", async () => {
  const { api, calls } = gateway();
  render(apps(api));
  await openAccounts();
  fireEvent.click(await screen.findByRole("button", { name: "Revoke slack/team" }));
  await waitFor(() =>
    expect(calls.some((c) => c.method === "DELETE" && c.path.endsWith("/connections/icn_1"))).toBe(
      true,
    ),
  );
  search("slack");
  fireEvent.click(await screen.findByRole("button", { name: "Unadopt slack" }));
  await waitFor(() =>
    expect(
      calls.some((c) => c.method === "DELETE" && c.path === "/api/integrations/providers/slack"),
    ).toBe(true),
  );
});

it("says once what is missing when no integration service is configured", async () => {
  const { api } = gateway(false);
  render(apps(api));
  expect(await screen.findByText(/Ask the person who runs Deskmates/)).toBeTruthy();
  expect(screen.queryByRole("searchbox")).toBeNull();
});

it("lists only apps ready here, featured first, and finds any app by search", async () => {
  const providers: IntegrationCatalogEntry[] = Array.from({ length: 30 }, (_, index) => ({
    service: `service-${String(index).padStart(2, "0")}`,
    displayName: `Provider ${String(index).padStart(2, "0")}`,
    authKinds: ["api_key"],
    adopted: true,
  }));
  providers.push({ service: "github", displayName: "GitHub", authKinds: ["oauth"], adopted: true });
  for (let index = 0; index < 40; index++)
    providers.push({
      service: `offline-${index}`,
      displayName: `Offline ${index}`,
      authKinds: ["api_key"],
      adopted: false,
    });
  const { api } = gateway(true, providers, []);
  render(apps(api));

  const grid = await screen.findByRole("list", { name: "Adopted providers" });
  await waitFor(() => expect(within(grid).getAllByRole("listitem")).toHaveLength(APPS_SHOWN_STEP));
  // Featured apps lead, and the logo is a release-local asset.
  expect(within(grid).getAllByRole("listitem")[0]).toHaveTextContent("GitHub");
  expect(grid.querySelector('img[src="/integration-logos/github.svg"]')).toBeTruthy();
  expect(screen.queryByText(/Offline/)).toBeNull();
  expect(screen.getByText("Showing 24 of 31")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show more" }));
  expect(within(grid).getAllByRole("listitem")).toHaveLength(31);

  fireEvent.click(screen.getByRole("button", { name: "Code · 1" }));
  expect(within(grid).getAllByRole("listitem")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "All · 31" }));

  search("offline-7");
  expect(await screen.findByText("Offline 7")).toBeTruthy();
  expect(screen.getByText("Needs the maintainer")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Enable Offline 7 on this installation" }),
  ).toBeTruthy();
  search("");

  fireEvent.click(screen.getByLabelText("Include apps not enabled on this installation"));
  expect(screen.getByText("Showing 24 of 71")).toBeTruthy();
});

it("orders and filters with a pure rule a test can read", () => {
  const entry = (service: string, adopted: boolean): IntegrationCatalogEntry => ({
    service,
    displayName: service,
    authKinds: ["api_key"],
    adopted,
  });
  const all = [
    entry("zeta", true),
    entry("gmail", true),
    entry("alpha", false),
    entry("slack", true),
  ];
  const options = {
    query: "",
    category: "all" as const,
    includeNotEnabled: false,
    connected: (service: string) => service === "slack",
  };
  expect(listedApps(all, options).map((p) => p.service)).toEqual(["gmail", "zeta"]);
  expect(listedApps(all, { ...options, query: "a" }).map((p) => p.service)).toEqual([
    "gmail",
    "slack",
    "alpha",
    "zeta",
  ]);
});

it("pages connected accounts, counts them from the aggregate, and clamps after a revoke (#113)", async () => {
  // 51 Slack accounts: three pages of 25. The count is the workspace's, not the page's.
  const many = Array.from({ length: 51 }, (_, i) => ({
    ...connection,
    id: `icn_${String(i).padStart(2, "0")}`,
    connectionName: `team-${String(i).padStart(2, "0")}`,
  }));
  const { api, calls } = gateway(true, [slackProvider], many);
  render(apps(api));
  await openAccounts();
  const pages = await screen.findByRole("navigation", { name: "Connected account pages" });
  await waitFor(() => expect(pages).toHaveTextContent("1–25 of 51"));
  const inUse = screen.getByRole("region", { name: "In use" });
  expect(within(inUse).getByText("51 connected")).toBeTruthy();
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
  expect(within(inUse).getByText("50 connected")).toBeTruthy();
});

it("shows a Member what is ready without offering actions they cannot take", async () => {
  const { api } = gateway(
    true,
    [{ service: "github", displayName: "GitHub", authKinds: ["oauth"], adopted: false }],
    [],
  );
  render(
    <SessionRolesProvider roles={{ tenantRole: "member", platformMaintainer: false }}>
      {apps(api)}
    </SessionRolesProvider>,
  );
  expect(await screen.findByText(/No app is enabled on this installation yet/)).toBeTruthy();
  search("git");
  expect(await screen.findByText("Needs the maintainer")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Enable/ })).toBeNull();
  expect(screen.queryByLabelText("Include apps not enabled on this installation")).toBeNull();
});

it("says how many bots may use each app in use (ADR-0055)", async () => {
  const { api } = gateway();
  const bot = (id: string, integrationApps?: string[]) => ({
    id,
    workspaceId: "ws_1",
    name: id,
    role: "r",
    soulVersion: 1,
    connectors: [],
    messageAllowlist: [],
    cron: [],
    createdAt: "x",
    ...(integrationApps ? { integrationApps } : {}),
  });
  vi.spyOn(api, "getWorkspace").mockResolvedValue({
    workspace,
    bots: [bot("bot_1"), bot("bot_2", ["github"]), bot("bot_3", ["slack"])],
  } as never);
  render(apps(api));
  const inUse = await screen.findByRole("region", { name: "In use" });
  expect(await within(inUse).findByText(/2 of 3 Bots may use it/)).toBeTruthy();
});

it("discards canceled credentials before another app is opened", async () => {
  const { api, calls } = gateway(true, [
    slackProvider,
    {
      service: "notion",
      displayName: "Notion",
      authKinds: ["api_key"],
      adopted: true,
    },
  ]);
  render(apps(api));
  fireEvent.click(await screen.findByRole("button", { name: "Add another Slack account" }));
  fireEvent.change(await screen.findByLabelText("Connection name"), {
    target: { value: "unfinished" },
  });
  fireEvent.change(screen.getByLabelText("API key"), {
    target: { value: "test-only-canceled-key" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Close connect" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Add another Slack account" })).toHaveFocus(),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Connect Notion" }));
  expect(await screen.findByLabelText("Connection name")).toHaveValue("main");
  expect(screen.getByLabelText("API key")).toHaveValue("");
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
});

it("locks account fields during submission and retains the name after a refusal", async () => {
  const { api } = gateway();
  let rejectSave!: (error: Error) => void;
  vi.spyOn(api, "createApiKeyConnection").mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        rejectSave = reject;
      }),
  );
  render(apps(api));
  fireEvent.click(await screen.findByRole("button", { name: "Add another Slack account" }));
  fireEvent.change(await screen.findByLabelText("Connection name"), {
    target: { value: "team-2" },
  });
  fireEvent.change(screen.getByLabelText("API key"), { target: { value: "test-only-key" } });
  fireEvent.click(screen.getByRole("button", { name: "Save API key" }));
  expect(screen.getByLabelText("Connection name")).toBeDisabled();
  expect(screen.getByLabelText("API key")).toBeDisabled();
  await act(async () => rejectSave(new Error("Connection refused")));
  expect(screen.getByRole("alert")).toHaveTextContent("Connection refused");
  expect(screen.getByLabelText("Connection name")).toHaveValue("team-2");
  expect(screen.getByLabelText("Connection name")).toBeEnabled();
});

it("retries catalog status without losing the account list", async () => {
  const { api } = gateway();
  const original = api.getIntegrations.bind(api);
  vi.spyOn(api, "getIntegrations")
    .mockRejectedValueOnce(new Error("Catalog unavailable"))
    .mockImplementationOnce(original);
  render(apps(api));
  expect(await screen.findByRole("alert")).toHaveTextContent("Catalog unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("region", { name: "In use" });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("recovers account reads independently of the catalog", async () => {
  const { api } = gateway();
  const original = api.listIntegrationConnections.bind(api);
  vi.spyOn(api, "listIntegrationConnections")
    .mockRejectedValueOnce(new Error("Accounts unavailable"))
    .mockImplementationOnce(original);
  const catalog = vi.spyOn(api, "getIntegrationCatalog");
  render(apps(api));
  expect(await screen.findByRole("alert")).toHaveTextContent("Accounts unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("region", { name: "In use" });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(catalog).toHaveBeenCalledTimes(1);
});

it("only explains Drive file access when connecting Google Drive", async () => {
  const { api } = gateway(true, [
    slackProvider,
    { service: "googledrive", displayName: "Google Drive", authKinds: ["oauth"], adopted: true },
  ]);
  render(apps(api));
  fireEvent.click(await screen.findByRole("button", { name: "Add another Slack account" }));
  expect(
    within(screen.getByRole("dialog")).queryByText(/grants file access separately/),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Close connect" }));
  fireEvent.click(await screen.findByRole("button", { name: "Connect Google Drive" }));
  expect(
    within(screen.getByRole("dialog")).getByText(/grants file access separately/),
  ).toBeInTheDocument();
});
