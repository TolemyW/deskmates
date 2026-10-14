// Demo routes and seed of Integrations: the runtime catalog with two adopted providers, one
// connected account and one registered database connector.

import type {
  ConnectorRegistration,
  IntegrationCatalogEntry,
  IntegrationConnection,
  WorkspaceId,
} from "@deskmates/contracts";
import type { DemoFeature, DemoRequest, DemoSeedContext } from "../../demo/feature.js";
import { type Result, created, notFound, ok } from "../../demo/result.js";
import { type DemoState, id, minutesAgo } from "../../demo/state.js";

const store = (s: DemoState) =>
  s.store("integrations", () => ({
    providers: [] as (IntegrationCatalogEntry & { adoptedAt: string })[],
    connections: [] as IntegrationConnection[],
    connectors: [] as ConnectorRegistration[],
  }));

export const demo: DemoFeature = { route, seed: { after: "team", run: seed } };

function route(req: DemoRequest, s: DemoState): Result | Promise<Result> | undefined {
  const { method, path, query: q, body: b } = req;
  const m = (re: RegExp) => req.match(re);
  let x: RegExpMatchArray | null;
  if (path === "/api/integrations")
    return ok({
      configured: true,
      oauthAvailable: true,
      providers: store(s)
        .providers.filter((p) => p.adopted)
        .map(({ adopted: _a, ...p }) => p),
    });
  if (path === "/api/integrations/catalog")
    return ok({ configured: true, complete: true, providers: store(s).providers });
  if (path === "/api/integrations/providers" && method === "POST") {
    const found = store(s).providers.find((p) => p.service === b.service);
    if (!found) return notFound("provider");
    found.adopted = true;
    const { adopted: _a, ...provider } = found;
    return created({ provider });
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/integrations\/providers\/([^/]+)$/)) && method === "DELETE") {
    const found = store(s).providers.find((p) => p.service === decodeURIComponent(x?.[1] ?? ""));
    if (found) found.adopted = false;
    return ok({ ok: true });
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/integrations\/workspaces\/([^/]+)\/connections$/))) {
    // One page, oldest first, with the total and the live counts per service (#113).
    const ws = decodeURIComponent(x?.[1] ?? "");
    const own = store(s).connections.filter((c) => c.workspaceId === ws);
    const status = q.get("status");
    const listed = own.filter((c) =>
      status === "live" ? !c.revokedAt : status === "revoked" ? Boolean(c.revokedAt) : true,
    );
    const counts = new Map<string, number>();
    for (const c of own) if (!c.revokedAt) counts.set(c.service, (counts.get(c.service) ?? 0) + 1);
    const page = offsetPage(listed, q);
    return ok({
      connections: page.items,
      offset: page.offset,
      limit: page.limit,
      total: page.total,
      liveByService: [...counts]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([service, count]) => ({ service, count })),
    });
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/integrations\/workspaces\/([^/]+)\/connections\/api-key$/))) {
    const ws = decodeURIComponent(x?.[1] ?? "") as WorkspaceId;
    const connection: IntegrationConnection = {
      id: id("icn") as IntegrationConnection["id"],
      workspaceId: ws,
      service: String(b.service),
      connectionName: String(b.connectionName),
      runtimeConnectionId: id("rt"),
      authKind: "api_key",
      createdAt: new Date().toISOString(),
    };
    store(s).connections.push(connection);
    return created({ connection });
  }
  if (m(/^\/api\/integrations\/workspaces\/([^/]+)\/connections\/oauth\/start$/))
    return ok({ authorizationUrl: "https://example.test/oauth/authorize?demo=1" });
  if (
    // biome-ignore lint/suspicious/noAssignInExpressions: route matching
    (x = m(/^\/api\/integrations\/workspaces\/([^/]+)\/connections\/([^/]+)$/)) &&
    method === "DELETE"
  ) {
    const found = store(s).connections.find((c) => c.id === decodeURIComponent(x?.[2] ?? ""));
    if (!found) return notFound("connection");
    found.revokedAt = new Date().toISOString();
    return ok({ connection: found });
  }
  if (path === "/api/connectors" && method === "GET") {
    const ws = q.get("workspaceId");
    const listed = ws
      ? store(s).connectors.filter((c) => c.workspaceId === ws)
      : store(s).connectors;
    const page = offsetPage(listed, q);
    return ok({
      connectors: page.items,
      offset: page.offset,
      limit: page.limit,
      total: page.total,
    });
  }
  if (path === "/api/connectors" && method === "POST") {
    const connector: ConnectorRegistration = {
      id: id("con") as ConnectorRegistration["id"],
      workspaceId: b.workspaceId as WorkspaceId,
      name: String(b.name),
      kind: String(b.kind ?? "database"),
      publicUrl: b.publicUrl === true,
      createdAt: new Date().toISOString(),
    };
    store(s).connectors.push(connector);
    return created({ connector });
  }
  return undefined;
}

/** One offset page of a list the demo already keeps oldest first, 25 by default (#113). */
function offsetPage<T>(rows: T[], q: URLSearchParams) {
  const limit = Number(q.get("limit") ?? 25) || 25;
  const offset = Number(q.get("offset") ?? 0) || 0;
  return { items: rows.slice(offset, offset + limit), offset, limit, total: rows.length };
}

/** What the runtime offers, two adopted, one account connected, one database. */
function seed(s: DemoState, { now, ws }: DemoSeedContext): void {
  const at = minutesAgo(60 * 24 * 6, now);
  const catalog: [string, string, ("oauth" | "api_key")[], boolean][] = [
    ["github", "GitHub", ["oauth", "api_key"], true],
    ["slack", "Slack", ["oauth"], true],
    ["googledrive", "Google Drive", ["oauth"], false],
    ["googlecalendar", "Google Calendar", ["oauth"], false],
    ["gmail", "Gmail", ["oauth"], false],
    ["notion", "Notion", ["oauth", "api_key"], false],
    ["linear", "Linear", ["oauth", "api_key"], false],
    ["jira", "Jira", ["oauth", "api_key"], false],
    ["hubspot", "HubSpot", ["oauth"], false],
    ["airtable", "Airtable", ["oauth", "api_key"], false],
    ["stripe", "Stripe", ["api_key"], false],
    ["sendgrid", "SendGrid", ["api_key"], false],
  ];
  for (const [service, displayName, authKinds, adopted] of catalog)
    store(s).providers.push({ service, displayName, authKinds, adopted, adoptedAt: at });
  store(s).connections.push({
    id: id("icn") as IntegrationConnection["id"],
    workspaceId: ws.id,
    service: "github",
    connectionName: "main",
    runtimeConnectionId: id("rt"),
    authKind: "oauth",
    createdAt: at,
  });
  store(s).connectors.push({
    id: id("con") as ConnectorRegistration["id"],
    workspaceId: ws.id,
    name: "galaxy-db",
    kind: "database",
    publicUrl: false,
    createdAt: at,
  });
}
