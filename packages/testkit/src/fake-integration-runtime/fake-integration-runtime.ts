// In-process fake of the integration runtime ADR-0013 puts behind the Gateway (OpenConnector
// v1.7.0 as the spike recorded it, `spikes/openconnector/out/`), served through a `fetch` function
// so a T1 Gateway calls it with no socket. It implements the surface the Gateway's adapter uses:
//
//   admin (Bearer admin token)          GET  /v1/providers/:service/setup
//   admin until a runtime token exists, GET  /v1/providers
//   then runtime token only (v1.7.0)
//                                       GET  /api/connections
//                                       PUT  /api/connections/:service     {authType:"api_key", connectionName, values}
//                                       DELETE /api/connections/:service   {connectionName}
//                                       POST /api/runtime-tokens           {name, allowed*, allowedConnections}
//                                       PUT  /api/runtime-tokens/:id       (policy sent whole)
//                                       DELETE /api/runtime-tokens/:id
//                                       PUT  /api/oauth/configs/:service   {clientId, clientSecret, redirectUri, ...}
//                                       POST /api/oauth/authorizations     {service, connectionName}
//   public, bound to `state`            GET  /oauth/callback?code&state
//   runtime token                       POST /mcp  tools/call list_apps | list_connections |
//                                                  search_actions | get_action_guide | execute_action
//
// A runtime token's `allowedConnections` is enforced on guide and execute exactly as the spike
// measured (`connection_not_allowed` before any credential is read; an empty list grants all), and
// every execution is logged, which is the reference a ledger count is reconciled against.

import { randomUUID } from "node:crypto";
import {
  FAKE_ACTIONS,
  FAKE_GITEA_REPOSITORIES,
  FAKE_PROVIDERS,
  type FakeCatalogAction,
} from "./catalog.js";

export interface FakeIntegrationRuntimeOptions {
  /** Default `http://integration-runtime.test`; may carry a mount prefix. Other origins are 404. */
  baseUrl?: string;
  /** Default `fake-admin-token`. */
  adminToken?: string;
  /** How MCP answers are framed: a one-event SSE body (v1.7.0's habit, the default) or JSON. */
  mcpResponse?: "sse" | "json";
}

export interface FakeRuntimeConnection {
  id: string;
  service: string;
  connectionName: string;
  authType: "api_key" | "oauth2" | "no_auth";
  virtual: boolean;
  /** The credential the runtime holds; never returned by any route. */
  secret: string;
  displayName: string;
}

export interface FakeRuntimeToken {
  id: string;
  token: string;
  name: string;
  allowedActions: string[];
  allowedConnections: string[];
  revoked: boolean;
}

export interface FakeRuntimeExecution {
  executionId: string;
  actionId: string;
  connectionId: string;
  connectionName: string;
  tokenId: string;
  input: Record<string, unknown>;
}

export interface FakeRuntimeRequest {
  method: string;
  path: string;
  authorization?: string;
  body: string;
}

interface OAuthConfig {
  clientId: string;
  redirectUri?: string;
  requestedScopes?: string[];
}

const CONNECTION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function jsonError(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  return new Headers(init?.headers).get(name) ?? undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function patternMatches(pattern: string, actionId: string): boolean {
  if (pattern.endsWith(".*")) return actionId.startsWith(pattern.slice(0, -1));
  return pattern === actionId;
}

export class FakeIntegrationRuntime {
  readonly baseUrl: string;
  readonly adminToken: string;
  readonly requests: FakeRuntimeRequest[] = [];
  /** Actions the runtime executed, in order. Refused calls are not here. */
  readonly executions: FakeRuntimeExecution[] = [];
  /** Code exchanges the OAuth callback performed. */
  readonly oauthExchanges: { service: string; connectionName: string; code: string }[] = [];
  readonly connections = new Map<string, FakeRuntimeConnection>();
  readonly tokens = new Map<string, FakeRuntimeToken>();
  readonly oauthConfigs = new Map<string, OAuthConfig>();
  private readonly pendingStates = new Map<string, { service: string; connectionName: string }>();
  private readonly mcpMode: "sse" | "json";
  private available = true;
  /** Synthetic provider behavior after the real fake's token/connection checks. No network. */
  actionResult:
    | ((
        actionId: string,
        input: Record<string, unknown>,
      ) => { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } })
    | undefined;

  constructor(opts: FakeIntegrationRuntimeOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://integration-runtime.test").replace(/\/+$/, "");
    this.adminToken = opts.adminToken ?? "fake-admin-token";
    this.mcpMode = opts.mcpResponse ?? "sse";
    for (const p of FAKE_PROVIDERS) {
      if (!p.authTypes.includes("no_auth")) continue;
      const id = `${p.service}:default`;
      this.connections.set(id, {
        id,
        service: p.service,
        connectionName: "default",
        authType: "no_auth",
        virtual: true,
        secret: "",
        displayName: `${p.displayName} Public`,
      });
    }
  }

  /** Simulate the runtime going away: every request fails as a network error. */
  setAvailable(available: boolean): void {
    this.available = available;
  }

  /** The named connection of a service, or undefined. */
  connection(service: string, connectionName: string): FakeRuntimeConnection | undefined {
    return [...this.connections.values()].find(
      (c) => c.service === service && c.connectionName === connectionName,
    );
  }

  /** The persistent runtime token record with this name that is not revoked. */
  tokenNamed(name: string): FakeRuntimeToken | undefined {
    return [...this.tokens.values()].find((t) => t.name === name && !t.revoked);
  }

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : "";
    const authorization = headerOf(init, "authorization");
    if (!this.available) throw new TypeError("fetch failed");
    if (!url.startsWith(`${this.baseUrl}/`)) return jsonError(404, "not_found", "Not found.");
    const parsedUrl = new URL(url);
    const path = parsedUrl.pathname.slice(new URL(this.baseUrl).pathname.replace(/\/$/, "").length);
    this.requests.push({
      method,
      path,
      ...(authorization === undefined ? {} : { authorization }),
      body,
    });
    const bearer = authorization?.replace(/^Bearer\s+/i, "");
    let parsed: Record<string, unknown> = {};
    try {
      parsed = body === "" ? {} : record(JSON.parse(body));
    } catch {
      return jsonError(400, "invalid_json", "Body is not JSON.");
    }

    if (method === "GET" && path === "/health") return json({ ok: true });
    if (method === "GET" && path === "/oauth/callback") return this.callback(parsedUrl);
    if (method === "POST" && path === "/mcp") return this.mcp(bearer, parsed);
    if (method === "GET" && path === "/v1/providers") return this.providerList(bearer);

    if (bearer !== this.adminToken)
      return jsonError(401, "unauthorized", "A valid administrator bearer token is required.");

    const setup = /^\/v1\/providers\/([^/]+)\/setup$/.exec(path);
    if (method === "GET" && setup) {
      const provider = FAKE_PROVIDERS.find((p) => p.service === setup[1]);
      if (!provider) return jsonError(404, "unknown_service", `Unknown service: ${setup[1]}.`);
      return json({
        success: true,
        message: "OK",
        data: { service: provider.service, auth: provider.authTypes.map((type) => ({ type })) },
      });
    }
    if (method === "GET" && path === "/api/connections")
      return json([...this.connections.values()].map((c) => this.view(c)));
    const conn = /^\/api\/connections\/([^/]+)$/.exec(path);
    if (conn && method === "PUT") return this.putConnection(conn[1] ?? "", parsed);
    if (conn && method === "DELETE") return this.deleteConnection(conn[1] ?? "", parsed);
    if (method === "POST" && path === "/api/runtime-tokens") return this.createToken(parsed);
    const tok = /^\/api\/runtime-tokens\/([^/]+)$/.exec(path);
    if (tok && method === "PUT") return this.updateToken(tok[1] ?? "", parsed);
    if (tok && method === "DELETE") return this.revokeToken(tok[1] ?? "");
    const cfg = /^\/api\/oauth\/configs\/([^/]+)$/.exec(path);
    if (cfg && method === "PUT") return this.putOAuthConfig(cfg[1] ?? "", parsed);
    if (method === "POST" && path === "/api/oauth/authorizations") return this.authorize(parsed);
    return jsonError(404, "not_found", "Not found.");
  };

  private view(c: FakeRuntimeConnection): Record<string, unknown> {
    return {
      id: c.id,
      service: c.service,
      connectionName: c.connectionName,
      authType: c.authType,
      configured: true,
      virtual: c.virtual,
      default: c.virtual,
      profile: { accountId: `${c.service}:${c.id}`, displayName: c.displayName, grantedScopes: [] },
    };
  }

  private putConnection(service: string, body: Record<string, unknown>): Response {
    if (!FAKE_PROVIDERS.some((p) => p.service === service))
      return jsonError(404, "unknown_service", `Unknown service: ${service}.`);
    if (body.authType !== "api_key")
      return jsonError(400, "unsupported_auth_type", `${service} does not support that.`);
    const values = record(body.values);
    const apiKey = values.apiKey;
    if (typeof apiKey !== "string" || apiKey === "")
      return jsonError(400, "invalid_input", "apiKey is required.");
    // The runtime validates the credential against the provider before the name (spike §9).
    if (apiKey === "rejected-by-provider")
      return jsonError(401, "authorization_failed", "The provider rejected the credential.");
    const name = typeof body.connectionName === "string" ? body.connectionName : "default";
    if (!CONNECTION_NAME.test(name))
      return jsonError(
        400,
        "invalid_connection_name",
        "Connection names must start with a letter or digit, contain only letters, digits, underscores, or hyphens, and be at most 64 characters.",
      );
    const existing = this.connection(service, name);
    const c: FakeRuntimeConnection = {
      id: existing?.id ?? randomUUID(),
      service,
      connectionName: name,
      authType: "api_key",
      virtual: false,
      secret: apiKey,
      displayName: "Spike Bot",
    };
    this.connections.set(c.id, c);
    return json(this.view(c));
  }

  private deleteConnection(service: string, body: Record<string, unknown>): Response {
    const name = typeof body.connectionName === "string" ? body.connectionName : "default";
    const c = this.connection(service, name);
    if (!c || c.virtual)
      return jsonError(404, "connection_not_found", `No ${service} connection ${name}.`);
    this.connections.delete(c.id);
    return json({ service, connectionName: name, configured: false });
  }

  private tokenPolicy(body: Record<string, unknown>): {
    allowedActions: string[];
    allowedConnections: string[];
  } {
    const strings = (v: unknown) =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    return {
      allowedActions: strings(body.allowedActions),
      allowedConnections: strings(body.allowedConnections),
    };
  }

  private summary(t: FakeRuntimeToken): Record<string, unknown> {
    return {
      id: t.id,
      name: t.name,
      allowedActions: t.allowedActions,
      blockedActions: [],
      allowedProxies: [],
      allowedConnections: t.allowedConnections,
      createdAt: "2026-09-29T11:50:09.234Z",
    };
  }

  private createToken(body: Record<string, unknown>): Response {
    if (typeof body.name !== "string" || body.name === "")
      return jsonError(400, "invalid_input", "name is required.");
    const t: FakeRuntimeToken = {
      id: randomUUID(),
      token: `oct_${randomUUID().replace(/-/g, "")}`,
      name: body.name,
      ...this.tokenPolicy(body),
      revoked: false,
    };
    this.tokens.set(t.id, t);
    return json({ token: t.token, record: this.summary(t) });
  }

  private updateToken(id: string, body: Record<string, unknown>): Response {
    const t = this.tokens.get(id);
    if (!t || t.revoked)
      return jsonError(404, "runtime_token_not_found", `Runtime token not found: ${id}.`);
    Object.assign(t, this.tokenPolicy(body));
    return json(this.summary(t));
  }

  private revokeToken(id: string): Response {
    const t = this.tokens.get(id);
    if (!t || t.revoked)
      return jsonError(404, "runtime_token_not_found", `Runtime token not found: ${id}.`);
    t.revoked = true;
    return json({ id, revoked: true });
  }

  private putOAuthConfig(service: string, body: Record<string, unknown>): Response {
    if (!FAKE_PROVIDERS.some((p) => p.service === service && p.authTypes.includes("oauth2")))
      return jsonError(400, "unsupported_auth_type", `${service} has no OAuth flow.`);
    const cfg: OAuthConfig = {
      clientId: typeof body.clientId === "string" ? body.clientId : "",
      ...(typeof body.redirectUri === "string" ? { redirectUri: body.redirectUri } : {}),
      ...(Array.isArray(body.requestedScopes)
        ? { requestedScopes: body.requestedScopes.filter((s) => typeof s === "string") }
        : {}),
    };
    this.oauthConfigs.set(service, cfg);
    const expected = cfg.redirectUri ?? `${this.baseUrl}/oauth/callback`;
    return json({
      service,
      configured: true,
      clientId: cfg.clientId,
      expectedRedirectUri: expected,
      redirectUri: cfg.redirectUri ?? null,
      missingFields: [],
    });
  }

  private authorize(body: Record<string, unknown>): Response {
    const service = typeof body.service === "string" ? body.service : "";
    const name = typeof body.connectionName === "string" ? body.connectionName : "default";
    if (!CONNECTION_NAME.test(name))
      return jsonError(400, "invalid_connection_name", "Invalid connection name.");
    const cfg = this.oauthConfigs.get(service);
    if (!cfg || cfg.clientId === "")
      return jsonError(400, "oauth_client_not_configured", `Configure ${service} OAuth first.`);
    const state = randomUUID();
    this.pendingStates.set(state, { service, connectionName: name });
    const redirect = cfg.redirectUri ?? `${this.baseUrl}/oauth/callback`;
    const url = new URL(`https://auth.${service}.test/oauth/authorize`);
    url.searchParams.set("client_id", cfg.clientId);
    url.searchParams.set("redirect_uri", redirect);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    if (cfg.requestedScopes) url.searchParams.set("scope", cfg.requestedScopes.join(","));
    return json({ authorizationUrl: url.href, state });
  }

  private callback(url: URL): Response {
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const providerError = url.searchParams.get("error");
    if (providerError) {
      if (state) this.pendingStates.delete(state);
      return jsonError(400, "oauth_provider_error", `OAuth provider returned "${providerError}".`);
    }
    if (!state || !code)
      return jsonError(400, "invalid_oauth_callback", "OAuth callback requires state and code.");
    const pending = this.pendingStates.get(state);
    if (!pending)
      return jsonError(400, "invalid_oauth_state", "OAuth state is missing or expired.");
    this.pendingStates.delete(state);
    if (code === "rejected-code")
      return jsonError(400, "oauth_exchange_failed", "The provider rejected the code.");
    this.oauthExchanges.push({ ...pending, code });
    const existing = this.connection(pending.service, pending.connectionName);
    const c: FakeRuntimeConnection = {
      id: existing?.id ?? randomUUID(),
      service: pending.service,
      connectionName: pending.connectionName,
      authType: "oauth2",
      virtual: false,
      secret: `oauth-access-${code}`,
      displayName: "OAuth User",
    };
    this.connections.set(c.id, c);
    return new Response("<!doctype html><title>Connected</title><p>Connected.</p>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  }

  // --- MCP ---------------------------------------------------------------------------------

  private mcpReply(message: Record<string, unknown>, status = 200): Response {
    if (this.mcpMode === "json") return json(message, status);
    return new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
      status,
      headers: { "content-type": "text/event-stream" },
    });
  }

  private toolResult(id: unknown, payload: Record<string, unknown>): Response {
    const isError = payload.ok === false;
    return this.mcpReply({
      result: {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
        ...(isError ? { isError: true } : {}),
      },
      jsonrpc: "2.0",
      id,
    });
  }

  private mcp(bearer: string | undefined, body: Record<string, unknown>): Response {
    const token = [...this.tokens.values()].find((t) => t.token === bearer && !t.revoked);
    if (!token) return jsonError(401, "unauthorized", "A valid local bearer token is required.");
    const id = body.id;
    if (body.method === "tools/list")
      return this.mcpReply({
        result: {
          tools: [
            "list_apps",
            "list_connections",
            "search_actions",
            "get_action_guide",
            "execute_action",
          ].map((name) => ({ name })),
        },
        jsonrpc: "2.0",
        id,
      });
    if (body.method !== "tools/call")
      return this.mcpReply({
        error: { code: -32601, message: "Method not found" },
        jsonrpc: "2.0",
        id,
      });
    const params = record(body.params);
    const args = record(params.arguments);
    switch (params.name) {
      case "list_apps":
        return this.toolResult(id, this.listApps(args));
      case "list_connections":
        return this.toolResult(id, this.listConnections(token, args));
      case "search_actions":
        return this.toolResult(id, this.search(token, args));
      case "get_action_guide":
        return this.toolResult(id, this.guide(token, args));
      case "execute_action":
        return this.toolResult(id, this.execute(token, args));
      default:
        return this.mcpReply({
          error: { code: -32602, message: `Unknown tool ${String(params.name)}` },
          jsonrpc: "2.0",
          id,
        });
    }
  }

  /**
   * As v1.7.0 behaves (verified 2026-10-09): until the first runtime token exists the list is
   * answered to the admin token; from then on only a runtime ("local") token is accepted and the
   * admin token gets 401, which is why the Gateway reads the catalog through `list_apps`.
   */
  private providerList(bearer: string | undefined): Response {
    const live = [...this.tokens.values()].filter((t) => !t.revoked);
    const authorised =
      live.length === 0 ? bearer === this.adminToken : live.some((t) => t.token === bearer);
    if (!authorised)
      return jsonError(401, "unauthorized", "A valid local bearer token is required.");
    return json({
      success: true,
      message: "OK",
      data: FAKE_PROVIDERS.map((p) => ({
        service: p.service,
        displayName: p.displayName,
        iconUrl: null,
        categories: p.categories.map((id) => ({ id })),
        authTypes: p.authTypes,
      })),
    });
  }

  private listApps(args: Record<string, unknown>): Record<string, unknown> {
    const q = typeof args.query === "string" ? args.query.toLowerCase() : "";
    return {
      ok: true,
      data: FAKE_PROVIDERS.filter(
        (p) =>
          q === "" ||
          p.service.includes(q) ||
          p.displayName.toLowerCase().includes(q) ||
          p.categories.some((c) => c.toLowerCase().includes(q)),
      ).map((p) => {
        const count = FAKE_ACTIONS.filter((a) => a.id.startsWith(`${p.service}.`)).length;
        return { ...p, actionCount: count, executableActionCount: count };
      }),
    };
  }

  private granted(token: FakeRuntimeToken, c: FakeRuntimeConnection): boolean {
    return (
      c.virtual || token.allowedConnections.length === 0 || token.allowedConnections.includes(c.id)
    );
  }

  private listConnections(
    token: FakeRuntimeToken,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const service = typeof args.service === "string" ? args.service : undefined;
    return {
      ok: true,
      data: [...this.connections.values()]
        .filter((c) => (service === undefined || c.service === service) && this.granted(token, c))
        .map((c) => {
          const { configured: _c, virtual: _v, ...rest } = this.view(c);
          return rest;
        }),
    };
  }

  private actionAllowed(token: FakeRuntimeToken, actionId: string): boolean {
    return (
      token.allowedActions.length === 0 ||
      token.allowedActions.some((p) => patternMatches(p, actionId))
    );
  }

  private entry(token: FakeRuntimeToken, a: FakeCatalogAction): Record<string, unknown> {
    const service = a.id.slice(0, a.id.indexOf("."));
    return {
      id: a.id,
      service,
      name: a.id.slice(service.length + 1),
      description: a.description,
      operationType: a.operationType,
      capability: {
        operationType: a.operationType,
        requiredScopes: a.requiredScopes,
        providerPermissions: [],
        policy: { allowed: this.actionAllowed(token, a.id), checks: [] },
      },
      inputSummary: a.inputSummary,
    };
  }

  private search(token: FakeRuntimeToken, args: Record<string, unknown>): Record<string, unknown> {
    const q = typeof args.query === "string" ? args.query.toLowerCase() : "";
    const service = typeof args.service === "string" ? args.service : undefined;
    const limit =
      typeof args.limit === "number" ? Math.max(1, Math.min(50, Math.floor(args.limit))) : 20;
    const hits = FAKE_ACTIONS.filter(
      (a) =>
        (service === undefined || a.id.startsWith(`${service}.`)) &&
        (q === "" ||
          a.id.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q) ||
          q.split(/\s+/).some((w) => w !== "" && a.id.toLowerCase().includes(w))),
    );
    return { ok: true, data: hits.slice(0, limit).map((a) => this.entry(token, a)) };
  }

  /** The connection a guide or execute call would use, or a refusal payload. */
  private resolve(
    token: FakeRuntimeToken,
    action: FakeCatalogAction,
    connectionName: unknown,
  ): { conn: FakeRuntimeConnection } | { refusal: Record<string, unknown> } {
    const service = action.id.slice(0, action.id.indexOf("."));
    const name = typeof connectionName === "string" ? connectionName : undefined;
    const c =
      name === undefined
        ? [...this.connections.values()].find((x) => x.service === service && x.virtual)
        : this.connection(service, name);
    const refuse = (code: string, message: string) => ({
      refusal: { ok: false, error: { code, message } },
    });
    if (c && !this.granted(token, c))
      return refuse(
        "connection_not_allowed",
        `${c.id} connection is not granted to this runtime token.`,
      );
    if (!c && name === undefined && token.allowedConnections.length > 0)
      return refuse(
        "connection_not_allowed",
        "The selected connection is not granted to this runtime token.",
      );
    if (!c) return refuse("authorization_failed", `Configure ${service} credentials first.`);
    return { conn: c };
  }

  private guide(token: FakeRuntimeToken, args: Record<string, unknown>): Record<string, unknown> {
    const action = FAKE_ACTIONS.find((a) => a.id === args.actionId);
    if (!action)
      return { ok: false, error: { code: "unknown_action", message: "Unknown action." } };
    const resolved = this.resolve(token, action, args.connectionName);
    if ("refusal" in resolved) return resolved.refusal;
    const { conn } = resolved;
    const inputs = action.inputSummary
      .map((i) => `| ${i.name} | ${i.type} | ${i.required ? "yes" : "no"} | ${i.description} |`)
      .join("\n");
    const markdown = [
      `# ${action.id}`,
      "",
      action.description,
      "",
      "## Execute",
      "",
      `Call execute_action with actionId ${action.id}.`,
      "",
      "## Input Parameters",
      "",
      "| Name | Type | Required | Description |",
      "| --- | --- | --- | --- |",
      inputs,
      "",
      "## Current Connection",
      "",
      `${conn.connectionName} (${conn.authType})`,
    ].join("\n");
    return {
      ok: true,
      data: {
        capability: {
          operationType: action.operationType,
          requiredScopes: action.requiredScopes,
          providerPermissions: [],
          policy: { allowed: true, checks: [] },
        },
        markdown,
      },
    };
  }

  private execute(token: FakeRuntimeToken, args: Record<string, unknown>): Record<string, unknown> {
    const executionId = randomUUID();
    const action = FAKE_ACTIONS.find((a) => a.id === args.actionId);
    if (!action)
      return {
        ok: false,
        error: { code: "unknown_action", message: `Unknown action: ${String(args.actionId)}.` },
      };
    if (!this.actionAllowed(token, action.id))
      return {
        ok: false,
        error: { code: "action_not_allowed", message: `${action.id} is not allowed.` },
        executionId,
        auditPersisted: true,
      };
    const resolved = this.resolve(token, action, args.connectionName);
    if ("refusal" in resolved) return { ...resolved.refusal, executionId, auditPersisted: true };
    const { conn } = resolved;
    const input = record(args.input);
    this.executions.push({
      executionId,
      actionId: action.id,
      connectionId: conn.id,
      connectionName: conn.connectionName,
      tokenId: token.id,
      input,
    });
    const scripted = this.actionResult?.(action.id, input);
    if (scripted) return { ...scripted, executionId, auditPersisted: true };
    const data =
      action.id === "gitea.list_my_repositories"
        ? FAKE_GITEA_REPOSITORIES
        : { executed: action.id, input };
    return {
      ok: true,
      data,
      executionId,
      auditPersisted: true,
      connection: {
        id: conn.id,
        service: conn.service,
        connectionName: conn.connectionName,
        authType: conn.authType,
        default: conn.virtual,
        profile: { displayName: conn.displayName, grantedScopes: [] },
      },
    };
  }
}
