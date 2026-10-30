// Demo routes and seed of Connections: the release's chat channels with one connected Telegram
// bot, the runtime catalog (sixty providers, a dozen enabled, one account connected) and one
// registered database connector.

import type {
  BotId,
  ChannelConnection,
  ConnectorRegistration,
  IntegrationCatalogEntry,
  IntegrationConnection,
  WorkspaceId,
} from "@deskmates/contracts";
import type { DemoFeature, DemoRequest, DemoSeedContext } from "../../demo/feature.js";
import { type Result, created, notFound, ok } from "../../demo/result.js";
import { type DemoState, id, minutesAgo } from "../../demo/state.js";
import { DEMO_CHANNEL_MANIFESTS } from "./demo-channels.js";

const store = (s: DemoState) =>
  s.store("integrations", () => ({
    providers: [] as (IntegrationCatalogEntry & { adoptedAt: string })[],
    connections: [] as IntegrationConnection[],
    connectors: [] as ConnectorRegistration[],
    channels: [] as ChannelConnection[],
    menuTargets: new Set<string>(),
    blocks: [] as { connectionId: string; senderId: string; note?: string }[],
  }));

/** A stand-in QR code: the demo has no phone to link. */
const DEMO_QR = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#fff"/><path d="M10 10h40v40H10zM110 10h40v40h-40zM10 110h40v40H10z" fill="#111"/></svg>',
)}`;

/** What each demo provider says its verified account is, as its identity call would. */
const DEMO_IDENTITIES: Record<string, { key: string; label: string }> = {
  telegram: { key: "telegram:bot:7001", label: "@galaxy_ops_demo_bot" },
  slack: { key: "slack:T0DEMO:A0DEMO", label: "Deskmates in Galaxy Ops" },
  discord: { key: "discord:app:1200000000000000001", label: "GalaxyOps" },
};

export const demo: DemoFeature = { route, seed: { after: "team", run: seed } };

function route(req: DemoRequest, s: DemoState): Result | Promise<Result> | undefined {
  const { method, path, query: q, body: b } = req;
  const m = (re: RegExp) => req.match(re);
  let x: RegExpMatchArray | null;
  const channels = channelRoute(req, s);
  if (channels) return channels;
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

/** Chat channels (ADR-0047): the catalog, a workspace's connections and their lifecycle. */
function channelRoute(req: DemoRequest, s: DemoState): Result | undefined {
  const { method, path, body: b } = req;
  const all = store(s).channels;
  if (path === "/api/channels" && method === "GET")
    return ok({
      plugins: DEMO_CHANNEL_MANIFESTS.map((manifest) => ({ manifest, state: "available" })),
      failures: [],
    });
  let x = req.match(/^\/api\/workspaces\/([^/]+)\/channels$/);
  if (x && method === "GET") {
    const ws = decodeURIComponent(x[1] ?? "");
    return ok({ connections: all.filter((c) => c.workspaceId === ws) });
  }
  x = req.match(/^\/api\/workspaces\/([^/]+)\/channels\/([^/]+)\/connect$/);
  if (x && method === "POST") {
    const ws = decodeURIComponent(x[1] ?? "") as WorkspaceId;
    const pluginId = decodeURIComponent(x[2] ?? "");
    const manifest = DEMO_CHANNEL_MANIFESTS.find((item) => item.id === pluginId);
    if (!manifest) return notFound("channel");
    const method = String(b.method ?? manifest.methods[0]?.id);
    const identity = DEMO_IDENTITIES[pluginId];
    const linked = method === "qr";
    const at = new Date().toISOString();
    const connection: ChannelConnection = {
      id: id("chn"),
      workspaceId: ws,
      pluginId,
      pluginVersion: manifest.version,
      method,
      botId: String(b.botId) as BotId,
      config: {},
      status: linked ? { phase: "qr", qr: DEMO_QR } : { phase: "connected" },
      apiVersion: 2,
      ...(identity && !linked ? { identityKey: identity.key, identityLabel: identity.label } : {}),
      bindingGeneration: 1,
      createdAt: at,
      updatedAt: at,
    };
    all.push(connection);
    return created({ connection });
  }
  const one = (connectionId: string) => all.find((c) => c.id === connectionId);
  x = req.match(/^\/api\/workspaces\/[^/]+\/channel-connections\/([^/]+)\/command-menu$/);
  if (x && method === "POST") {
    const connection = one(decodeURIComponent(x[1] ?? ""));
    const manifest = DEMO_CHANNEL_MANIFESTS.find((item) => item.id === connection?.pluginId);
    if (!connection || !manifest?.commandMenu) return notFound("command menu");
    const target = JSON.stringify([connection.id, b.scope, b.chatId, b.languageCode]);
    if (b.operation === "sync") store(s).menuTargets.add(target);
    return ok({
      commands: store(s).menuTargets.has(target)
        ? manifest.commandMenu
        : [{ command: "legacy", description: "Old menu entry" }],
      menuButton: "commands",
    });
  }

  x = req.match(/^\/api\/workspaces\/[^/]+\/channel-connections\/([^/]+)\/commands\/([a-z]+)$/);
  if (x && method === "POST") {
    const connection = one(decodeURIComponent(x[1] ?? ""));
    if (!connection) return notFound("connection");
    if (x[2] === "disconnect") store(s).channels = all.filter((c) => c !== connection);
    else connection.status = { phase: "connected" };
    return ok({ connection });
  }
  x = req.match(/^\/api\/workspaces\/([^/]+)\/channels\/([^/]+)\/commands\/([a-z]+)$/);
  if (x && method === "POST") {
    const connection = all.find((c) => c.pluginId === decodeURIComponent(x?.[2] ?? ""));
    if (!connection) return notFound("connection");
    if (x[3] === "disconnect") store(s).channels = all.filter((c) => c !== connection);
    else if (x[3] === "relink") connection.status = { phase: "qr", qr: DEMO_QR };
    else if (x[3] !== "test") connection.status = { phase: "connected" };
    return ok({ connection });
  }
  x = req.match(/^\/api\/workspaces\/[^/]+\/channel-connections\/([^/]+)\/rebind$/);
  if (x && method === "POST") {
    const connection = one(decodeURIComponent(x[1] ?? ""));
    if (!connection) return notFound("connection");
    connection.botId = String(b.botId) as BotId;
    connection.bindingGeneration = (connection.bindingGeneration ?? 1) + 1;
    return ok({ connection });
  }
  x = req.match(/^\/api\/workspaces\/[^/]+\/channel-connections\/([^/]+)\/blocks(?:\/([^/]+))?$/);
  if (x) {
    const connectionId = decodeURIComponent(x[1] ?? "");
    const blocks = store(s).blocks;
    if (method === "GET")
      return ok({ blocks: blocks.filter((b) => b.connectionId === connectionId) });
    if (method === "POST") {
      const block = {
        connectionId,
        senderId: String(b.senderId),
        createdBy: "demo",
        createdAt: new Date().toISOString(),
      };
      blocks.push(block);
      return created({ block });
    }
    if (method === "DELETE") {
      store(s).blocks = blocks.filter(
        (item) =>
          !(
            item.connectionId === connectionId && item.senderId === decodeURIComponent(x?.[2] ?? "")
          ),
      );
      return ok({ removed: true });
    }
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
function seed(s: DemoState, { now, ws, chief }: DemoSeedContext): void {
  const at = minutesAgo(60 * 24 * 6, now);
  const catalog: [string, string, ("oauth" | "api_key")[], boolean][] = [
    ["github", "GitHub", ["oauth", "api_key"], true],
    ["slack", "Slack", ["oauth"], true],
    ["googledrive", "Google Drive", ["oauth"], true],
    ["googlecalendar", "Google Calendar", ["oauth"], true],
    ["gmail", "Gmail", ["oauth"], true],
    ["notion", "Notion", ["oauth", "api_key"], true],
    ["linear", "Linear", ["oauth", "api_key"], true],
    ["jira", "Jira", ["oauth", "api_key"], true],
    ["confluence", "Confluence", ["oauth"], true],
    ["hubspot", "HubSpot", ["oauth"], true],
    ["airtable", "Airtable", ["oauth", "api_key"], true],
    ["stripe", "Stripe", ["api_key"], true],
    ["gitlab", "GitLab", ["oauth", "api_key"], false],
    ["sendgrid", "SendGrid", ["api_key"], false],
  ];
  // The long tail a real runtime lists: present in search, never in the default list.
  for (const name of [
    "Asana",
    "Basecamp",
    "Bitbucket",
    "Box",
    "Calendly",
    "ClickUp",
    "Dropbox",
    "Figma",
    "Freshdesk",
    "Front",
    "Intercom",
    "Mailchimp",
    "Miro",
    "Monday",
    "Outlook",
    "Pipedrive",
    "QuickBooks",
    "Salesforce",
    "Sentry",
    "Shopify",
    "Smartsheet",
    "Todoist",
    "Trello",
    "Twilio",
    "Typeform",
    "Webflow",
    "WordPress",
    "Xero",
    "YouTube",
    "Zendesk",
    "Zoom",
    "Teams",
    "OneDrive",
    "SharePoint",
    "PagerDuty",
    "Datadog",
    "Mixpanel",
    "Segment",
    "Postmark",
    "Zapier",
    "Coda",
    "Harvest",
    "Gusto",
    "DocuSign",
    "Brex",
    "Ramp",
  ])
    catalog.push([name.toLowerCase(), name, ["oauth", "api_key"], false]);
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
  store(s).channels.push({
    // A fixed id: drawing from the shared sequence would renumber every later demo record.
    id: "chn_demo_telegram",
    workspaceId: ws.id,
    pluginId: "telegram",
    pluginVersion: "1.0.0",
    method: "token",
    botId: ws.defaultBotId ?? chief.id,
    config: {},
    status: { phase: "connected" },
    apiVersion: 2,
    identityKey: "telegram:bot:7000",
    identityLabel: "@galaxy_ops_bot",
    bindingGeneration: 1,
    createdAt: at,
    updatedAt: minutesAgo(12, now),
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
