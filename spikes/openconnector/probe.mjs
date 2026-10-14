// Probe a running OpenConnector for the five ADR-0013 spike questions. Runs inside a node container
// on the spike's internal network (see probe.sh); writes every request/response pair to /out.
// No model is called and no real provider is reached: the only provider with a credential is the
// mock Gitea, and the network has no route off the host.
import { mkdirSync, writeFileSync } from "node:fs";
import { createMcpClient } from "./mcp-client.mjs";

const BASE = process.env.OC_BASE;
const ADMIN = process.env.OOMOL_CONNECT_ADMIN_TOKEN;
const OUT = process.env.OUT_DIR ?? "/out";
const MOCK_BASE_URL = "http://gitea.spike.internal:8080";
mkdirSync(OUT, { recursive: true });

function save(name, value) {
  writeFileSync(`${OUT}/${name}.json`, `${JSON.stringify(value, null, 2)}\n`);
}

async function http(method, path, { token, body, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  if (token) h.authorization = `Bearer ${token}`;
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text.length > 4000 ? `${text.slice(0, 4000)}...[${text.length} chars]` : text;
  }
  return {
    request: { method, path, headers: { ...h, ...(token ? { authorization: `Bearer ${token.slice(0, 6)}...` } : {}) }, body },
    response: {
      status: response.status,
      contentType: response.headers.get("content-type"),
      location: response.headers.get("location"),
      bytes: text.length,
      body: parsed,
    },
  };
}

/** The tool payload of a tools/call exchange: the text content the model would see. */
function toolText(exchange) {
  return exchange.response.body?.result?.content?.[0]?.text ?? "";
}

// ---------- A. surface and authentication defaults ----------
const surface = {};
surface.health = await http("GET", "/health");
surface.v1Health = await http("GET", "/v1/health");
surface.mcpToolsPreview = await http("GET", "/mcp/tools");
surface.consoleRootNoToken = await http("GET", "/");
surface.adminNoToken = await http("GET", "/api/connections");
surface.adminWithToken = await http("GET", "/api/connections", { token: ADMIN });
const openapi = await http("GET", "/openapi.json", { token: ADMIN });
surface.openapi = { status: openapi.response.status, bytes: openapi.response.bytes };
const providers = await http("GET", "/api/providers", { token: ADMIN });
surface.providers = {
  status: providers.response.status,
  bytes: providers.response.bytes,
  count: Array.isArray(providers.response.body) ? providers.response.body.length : null,
  actionCount: Array.isArray(providers.response.body)
    ? providers.response.body.reduce((n, p) => n + (p.actions?.length ?? 0), 0)
    : null,
};
// Before any runtime token exists: is /mcp open to an unauthenticated caller?
const anon = createMcpClient({ url: `${BASE}/mcp` });
surface.mcpNoTokenBeforeRuntimeToken = await anon.request("tools/list");
save("01-surface", surface);

// ---------- B. connections and per-workspace scoping (question 2) ----------
const scope = {};
scope.createWsA = await http("PUT", "/api/connections/gitea", {
  token: ADMIN,
  body: { authType: "api_key", connectionName: "ws-a", values: { apiKey: "fake-token-a", baseUrl: MOCK_BASE_URL } },
});
scope.createWsB = await http("PUT", "/api/connections/gitea", {
  token: ADMIN,
  body: { authType: "api_key", connectionName: "ws-b", values: { apiKey: "fake-token-b", baseUrl: MOCK_BASE_URL } },
});
// Which characters a connection name accepts: could a workspace id be encoded in it?
scope.nameCharset = {};
for (const name of ["ws_01J9ZK.gitea-main", "ws/a/main", "ws:a:main", "WS A main", "x".repeat(80)]) {
  const r = await http("PUT", "/api/connections/gitea", {
    token: ADMIN,
    body: { authType: "api_key", connectionName: name, values: { apiKey: "fake", baseUrl: MOCK_BASE_URL } },
  });
  scope.nameCharset[name.length > 40 ? `x*${name.length}` : name] = {
    status: r.response.status,
    error: r.response.body?.error ?? r.response.body?.message ?? null,
  };
}
// The programmatic API has a free-text `comment`: is it a usable tag, and is it visible to runtime callers?
scope.createWithComment = await http("POST", "/v1/connections/gitea/connect/api-key", {
  token: ADMIN,
  body: { apiKey: "fake-token-c", extra: { baseUrl: MOCK_BASE_URL }, comment: "deskmates-workspace=ws-c" },
});
scope.adminList = await http("GET", "/api/connections", { token: ADMIN });
scope.programmaticList = await http("GET", "/v1/connections", { token: ADMIN });

const all = scope.adminList.response.body?.data ?? scope.adminList.response.body ?? [];
const list = Array.isArray(all) ? all : (all.connections ?? []);
const idOf = (name) => list.find((c) => c.service === "gitea" && c.connectionName === name)?.id;
const idA = idOf("ws-a");
const idB = idOf("ws-b");
scope.ids = { idA, idB };

scope.tokenA = await http("POST", "/api/runtime-tokens", {
  token: ADMIN,
  body: { name: "workspace-ws-a", allowedActions: [], blockedActions: [], allowedProxies: [], allowedConnections: [idA] },
});
scope.tokenB = await http("POST", "/api/runtime-tokens", {
  token: ADMIN,
  body: { name: "workspace-ws-b", allowedActions: [], blockedActions: [], allowedProxies: [], allowedConnections: [idB] },
});
// An unrestricted token, the shape a Gateway would use for catalog calls that name no connection.
scope.tokenCatalog = await http("POST", "/api/runtime-tokens", {
  token: ADMIN,
  body: { name: "catalog-unscoped", allowedActions: [], blockedActions: [], allowedProxies: [] },
});
const tokenA = scope.tokenA.response.body?.token;
const tokenB = scope.tokenB.response.body?.token;
const tokenCatalog = scope.tokenCatalog.response.body?.token;
// Do not record the raw tokens.
for (const k of ["tokenA", "tokenB", "tokenCatalog"]) {
  const b = scope[k].response.body;
  if (b?.token) b.token = `${b.token.slice(0, 6)}...`;
}
scope.mcpNoTokenAfterRuntimeToken = await anon.request("tools/list");

const mcpA = createMcpClient({ url: `${BASE}/mcp`, token: tokenA });
const mcpB = createMcpClient({ url: `${BASE}/mcp`, token: tokenB });
scope.mcpInitA = await mcpA.initialize();
scope.listConnectionsA = await mcpA.callTool("list_connections", {});
scope.listConnectionsB = await mcpB.callTool("list_connections", {});
scope.listConnectionsAService = await mcpA.callTool("list_connections", { service: "gitea" });
scope.executeAOwn = await mcpA.callTool("execute_action", {
  actionId: "gitea.get_current_user",
  connectionName: "ws-a",
  input: {},
});
scope.executeAOther = await mcpA.callTool("execute_action", {
  actionId: "gitea.get_current_user",
  connectionName: "ws-b",
  input: {},
});
scope.executeANoName = await mcpA.callTool("execute_action", { actionId: "gitea.get_current_user", input: {} });
scope.guideAOther = await mcpA.callTool("get_action_guide", { actionId: "gitea.get_current_user", connectionName: "ws-b" });
scope.httpAOther = await http("POST", "/v1/actions/gitea.get_current_user", {
  token: tokenA,
  headers: { "x-oo-connector-alias": "ws-b" },
  body: { input: {} },
});
scope.httpAppsA = await http("GET", "/v1/apps/services/gitea", { token: tokenA });
scope.adminEndpointWithRuntimeToken = await http("GET", "/api/connections", { token: tokenA });
// A scoped token cannot read the guide of a service it has no connection for.
scope.guideAUnconnectedService = await mcpA.callTool("get_action_guide", { actionId: "slack.post_message" });
scope.searchAUnconnectedService = await mcpA.callTool("search_actions", { query: "post message", service: "slack", limit: 1 });
// Adding a connection to a workspace means updating that workspace's token grant.
const idC = scope.createWithComment.response.body?.data?.id;
const tokenARecordId = scope.tokenA.response.body?.record?.id;
scope.updateTokenA = await http("PUT", `/api/runtime-tokens/${tokenARecordId}`, {
  token: ADMIN,
  body: { name: "workspace-ws-a", allowedActions: [], blockedActions: [], allowedProxies: [], allowedConnections: [idA, idC] },
});
scope.listConnectionsAAfterUpdate = await mcpA.callTool("list_connections", { service: "gitea" });
// Virtual no_auth connections need no grant. Does a token's action allowlist keep a workspace to its
// adopted providers, and does it hide the no_auth entries from list_connections?
scope.tokenAdopted = await http("POST", "/api/runtime-tokens", {
  token: ADMIN,
  body: { name: "workspace-ws-a-adopted", allowedActions: ["gitea.*"], blockedActions: [], allowedProxies: [], allowedConnections: [idA] },
});
const tokenAdopted = scope.tokenAdopted.response.body?.token;
if (scope.tokenAdopted.response.body?.token) scope.tokenAdopted.response.body.token = `${tokenAdopted.slice(0, 6)}...`;
const mcpD = createMcpClient({ url: `${BASE}/mcp`, token: tokenAdopted });
scope.adoptedNoAuthExecute = await mcpD.callTool("execute_action", { actionId: "hackernews.get_item", input: { id: 1 } });
scope.adoptedGiteaExecute = await mcpD.callTool("execute_action", { actionId: "gitea.get_current_user", connectionName: "ws-a", input: {} });
scope.adoptedListConnections = await mcpD.callTool("list_connections", {});
scope.adoptedSearchSlack = await mcpD.callTool("search_actions", { query: "post message", service: "slack", limit: 1 });
save("02-scope", scope);

// ---------- C. MCP surface and token cost (question 1) ----------
// Catalog calls use the unscoped token: a scoped token is refused guides for unconnected services.
const mcpC = createMcpClient({ url: `${BASE}/mcp`, token: tokenCatalog });
const mcp = {};
mcp.initialize = await mcpC.initialize();
mcp.toolsList = await mcpC.request("tools/list");
mcp.listAppsAll = await mcpC.callTool("list_apps", {});
mcp.listAppsSlack = await mcpC.callTool("list_apps", { query: "slack" });
mcp.listAppsGoogleDrive = await mcpC.callTool("list_apps", { query: "google drive" });
mcp.searchSlack = await mcpC.callTool("search_actions", { query: "slack" });
mcp.searchGoogleDrive = await mcpC.callTool("search_actions", { query: "google drive" });
mcp.searchSlackPost = await mcpC.callTool("search_actions", { query: "post message", service: "slack" });
mcp.searchDriveFolder = await mcpC.callTool("search_actions", { query: "create folder", service: "googledrive" });
mcp.searchDriveShare = await mcpC.callTool("search_actions", { query: "share file", service: "googledrive" });
save("03-mcp-enumeration", {
  ...mcp,
  // list_apps with no query returns the whole catalog; keep its size and the first entries.
  listAppsAll: {
    request: mcp.listAppsAll.request,
    textChars: toolText(mcp.listAppsAll).length,
    compactChars: JSON.stringify(mcp.listAppsAll.response.body?.result?.structuredContent ?? null).length,
    cjkChars: (toolText(mcp.listAppsAll).match(/[぀-ヿ㐀-鿿가-힯＀-￯]/g) ?? []).length,
    entries: mcp.listAppsAll.response.body?.result?.structuredContent?.data?.length,
    firstEntries: mcp.listAppsAll.response.body?.result?.structuredContent?.data?.slice(0, 3),
  },
});

const guideIds = {
  slack: ["slack.post_message", "slack.list_channels", "slack.get_channel_messages", "slack.upload_file", "slack.add_reaction"],
  googledrive: [
    "googledrive.files.list",
    "googledrive.files.get",
    "googledrive.files.export",
    "googledrive.files.create",
    "googledrive.permissions.create",
  ],
  destructive: ["slack.delete_message", "googledrive.files.delete"],
};
const guides = {};
for (const id of [...guideIds.slack, ...guideIds.googledrive, ...guideIds.destructive]) {
  guides[id] = await mcpC.callTool("get_action_guide", { actionId: id });
}
save("04-action-guides", guides);
// The markdown alone, one file per action, for reading.
for (const [id, exchange] of Object.entries(guides)) {
  const md = exchange.response.body?.result?.structuredContent?.data?.markdown;
  if (md) writeFileSync(`${OUT}/guide-${id}.md`, md);
}

// ---------- D. end-to-end execute through MCP (question 4) ----------
const exec = {};
exec.giteaListRepos = await mcpA.callTool("execute_action", {
  actionId: "gitea.list_my_repositories",
  connectionName: "ws-a",
  input: { limit: 10 },
});
exec.giteaListReposHttp = await http("POST", "/v1/actions/gitea.list_my_repositories", {
  token: tokenA,
  headers: { "x-oo-connector-alias": "ws-a" },
  body: { input: { limit: 10 } },
});
// A no-auth provider on the public internet; the internal network has no route, so this shows the
// failure shape and that the only DNS lookup is the provider's own host.
exec.hackernewsNoEgress = await mcpA.callTool("execute_action", { actionId: "hackernews.get_top_stories", input: {} });
exec.unknownAction = await mcpA.callTool("execute_action", { actionId: "slack.nope", input: {} });
exec.slackWithoutConnection = await mcpC.callTool("execute_action", {
  actionId: "slack.list_channels",
  input: {},
});
exec.runs = await http("GET", "/api/runs", { token: ADMIN });
save("05-execute", exec);

// ---------- E. OAuth topology (question 3) ----------
const oauth = {};
const configs = await http("GET", "/api/oauth/configs", { token: ADMIN });
const cfgList = configs.response.body?.data ?? configs.response.body;
oauth.configsSummary = {
  status: configs.response.status,
  count: Array.isArray(cfgList) ? cfgList.length : null,
  slack: Array.isArray(cfgList) ? cfgList.find((c) => c.service === "slack") : null,
  googledrive: Array.isArray(cfgList) ? cfgList.find((c) => c.service === "googledrive") : null,
};
oauth.setupSlack = await http("GET", "/v1/providers/slack/setup", { token: ADMIN });
oauth.setupGoogleDrive = await http("GET", "/v1/providers/googledrive/setup", { token: ADMIN });
// Global OAuth app config with placeholder values: shows the accepted shape and the authorization URL
// the runtime builds. Building the URL needs no network; nobody can complete it.
oauth.putSlackConfig = await http("PUT", "/api/oauth/configs/slack", {
  token: ADMIN,
  body: { clientId: "PLACEHOLDER_SLACK_CLIENT_ID", clientSecret: "PLACEHOLDER_SLACK_CLIENT_SECRET" },
});
oauth.startSlackGlobalApp = await http("POST", "/api/oauth/authorizations", {
  token: ADMIN,
  body: { service: "slack", connectionName: "ws-a-slack" },
});
oauth.startSlackProgrammatic = await http("POST", "/v1/connections/slack/connect", {
  token: ADMIN,
  body: { returnUri: "https://deskmates-gateway.example.test/operator/integrations/done" },
});
// Connection-scoped OAuth app (OOMOL_CONNECT_ALLOWED_CUSTOM_OAUTH=slack,googledrive): no global config needed.
oauth.startDriveConnectionScoped = await http("POST", "/api/oauth/authorizations", {
  token: ADMIN,
  body: {
    service: "googledrive",
    connectionName: "ws-a-drive",
    clientId: "PLACEHOLDER.apps.googleusercontent.com",
    clientSecret: "PLACEHOLDER_GOOGLE_CLIENT_SECRET",
    requestedScopes: ["https://www.googleapis.com/auth/drive.readonly"],
  },
});
oauth.callbackBogusState = await http("GET", "/oauth/callback?state=not-a-real-state&code=x");
oauth.callbackWithoutPrefix = await fetch(`${BASE.replace(/\/integration-runtime$/, "")}/oauth/callback?state=x&code=y`).then(
  async (r) => ({ status: r.status, body: (await r.text()).slice(0, 200) }),
);
// Topology variant: the provider redirects to a Gateway route (which would forward code+state to the
// runtime's /oauth/callback), and the requested scopes are narrowed to what the ten actions need.
oauth.putSlackConfigGatewayRedirect = await http("PUT", "/api/oauth/configs/slack", {
  token: ADMIN,
  body: {
    clientId: "PLACEHOLDER_SLACK_CLIENT_ID",
    clientSecret: "PLACEHOLDER_SLACK_CLIENT_SECRET",
    redirectUri: "https://deskmates-gateway.example.test/operator/integrations/oauth/callback",
    requestedScopes: ["channels:read", "channels:history", "chat:write", "files:read", "files:write", "reactions:write"],
  },
});
oauth.startSlackGatewayRedirect = await http("POST", "/api/oauth/authorizations", {
  token: ADMIN,
  body: { service: "slack", connectionName: "ws-a-slack" },
});
oauth.deleteSlackConfig = await http("DELETE", "/api/oauth/configs/slack", { token: ADMIN });
save("06-oauth", oauth);

// ---------- F. catalog operationType for Slack and Google Drive ----------
const catalog = {};
for (const service of ["slack", "googledrive"]) {
  const r = await http("GET", `/v1/actions?service=${service}`, { token: tokenCatalog });
  const data = r.response.body?.data ?? [];
  const items = Array.isArray(data) ? data : (data.actions ?? []);
  catalog[service] = items.map((a) => ({ id: a.id, operationType: a.operationType, description: a.description }));
}
save("07-operation-types", catalog);

console.log("probe finished");
