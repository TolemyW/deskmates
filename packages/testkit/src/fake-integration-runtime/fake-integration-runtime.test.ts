// Self-test of the fake integration runtime: the shapes and refusals the OpenConnector spike
// recorded (`spikes/openconnector/out/02-scope.json`, `05-execute.json`, `06-oauth.json`), so the
// Gateway's T1 tests exercise the same behaviour the real runtime showed.

import { describe, expect, it } from "vitest";
import { FAKE_ACTIONS } from "./catalog.js";
import { FakeIntegrationRuntime } from "./fake-integration-runtime.js";

const BASE = "http://runtime.test/integration-runtime";

function setup(mcpResponse: "sse" | "json" = "sse") {
  const rt = new FakeIntegrationRuntime({ baseUrl: BASE, adminToken: "adm", mcpResponse });
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    token = "adm",
  ): Promise<{ status: number; json: Record<string, unknown> & unknown[] }> => {
    const res = await rt.fetch(`${BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    const payload = text.startsWith("event:")
      ? text
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("")
      : text;
    return {
      status: res.status,
      json: payload.startsWith("{") || payload.startsWith("[") ? JSON.parse(payload) : {},
    };
  };
  const tool = async (token: string, name: string, args: Record<string, unknown>) => {
    const r = await call(
      "POST",
      "/mcp",
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
      token,
    );
    return r.json.result as { structuredContent: Record<string, unknown>; isError?: boolean };
  };
  const apiKey = (name: string, key = "k") =>
    call("PUT", "/api/connections/gitea", {
      authType: "api_key",
      connectionName: name,
      values: { apiKey: key, baseUrl: "http://gitea.test" },
    });
  const mintToken = async (name: string, allowedConnections: string[]) => {
    const r = await call("POST", "/api/runtime-tokens", {
      name,
      allowedActions: [],
      blockedActions: [],
      allowedProxies: [],
      allowedConnections,
    });
    return r.json as unknown as { token: string; record: { id: string } };
  };
  return { rt, call, tool, apiKey, mintToken };
}

describe("fake integration runtime", () => {
  it("seeds the ten Slack and Drive actions of the spike with their operationType", () => {
    const types = Object.fromEntries(FAKE_ACTIONS.map((a) => [a.id, a.operationType]));
    expect(types).toMatchObject({
      "slack.post_message": "write",
      "slack.list_channels": "read",
      "slack.get_channel_messages": "read",
      "slack.upload_file": "write",
      "slack.add_reaction": "write",
      "googledrive.files.list": "read",
      "googledrive.files.get": "read",
      "googledrive.files.create": "write",
      "googledrive.permissions.create": "write",
      "googledrive.files.export": "read",
      "googledrive.files.delete": "destructive",
      "slack.delete_message": "destructive",
      "gitea.list_my_repositories": "read",
    });
  });

  it("guards the admin API with the admin token and MCP with a runtime token", async () => {
    const { call, mintToken } = setup();
    expect((await call("GET", "/api/connections", undefined, "nope")).status).toBe(401);
    expect((await call("POST", "/mcp", { method: "tools/list" }, "nope")).status).toBe(401);
    const t = await mintToken("ws", []);
    expect((await call("GET", "/api/connections", undefined, t.token)).status).toBe(401);
    expect((await call("POST", "/mcp", { method: "tools/list", id: 1 }, t.token)).status).toBe(200);
  });

  it("creates API-key connections, rejects bad names and never returns the key", async () => {
    const { call, apiKey } = setup();
    const ok = await apiKey("ws-a", "secret-key-a");
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({
      service: "gitea",
      connectionName: "ws-a",
      authType: "api_key",
    });
    expect((await apiKey("ws/a")).json).toMatchObject({
      error: { code: "invalid_connection_name" },
    });
    const listed = await call("GET", "/api/connections");
    expect(JSON.stringify(listed.json)).not.toContain("secret-key-a");
  });

  it("enforces allowedConnections on execute and logs only what it executed", async () => {
    const { rt, tool, apiKey, mintToken } = setup();
    const a = (await apiKey("ws-a")).json.id as string;
    const b = (await apiKey("ws-b")).json.id as string;
    const tokenA = await mintToken("ws-a", [a]);
    await mintToken("ws-b", [b]);

    const own = await tool(tokenA.token, "execute_action", {
      actionId: "gitea.list_my_repositories",
      connectionName: "ws-a",
      input: { limit: 10 },
    });
    expect(own.structuredContent).toMatchObject({ ok: true, executionId: expect.any(String) });
    expect(JSON.stringify(own.structuredContent)).toContain("</untrusted>");

    const other = await tool(tokenA.token, "execute_action", {
      actionId: "gitea.list_my_repositories",
      connectionName: "ws-b",
      input: {},
    });
    expect(other.isError).toBe(true);
    expect(other.structuredContent).toMatchObject({
      ok: false,
      error: { code: "connection_not_allowed" },
    });
    const noName = await tool(tokenA.token, "execute_action", {
      actionId: "gitea.list_my_repositories",
      input: {},
    });
    expect(noName.structuredContent).toMatchObject({ error: { code: "connection_not_allowed" } });
    expect(rt.executions.map((e) => e.connectionName)).toEqual(["ws-a"]);
  });

  it("lists only granted connections plus virtual no-auth ones, and rewrites grants whole", async () => {
    const { call, tool, apiKey, mintToken } = setup("json");
    const a = (await apiKey("ws-a")).json.id as string;
    const c = (await apiKey("ws-c")).json.id as string;
    const t = await mintToken("ws", [a]);
    const names = async () =>
      (
        (await tool(t.token, "list_connections", {})).structuredContent.data as {
          connectionName: string;
          service: string;
        }[]
      ).map((x) => `${x.service}/${x.connectionName}`);
    expect(await names()).toEqual(["hackernews/default", "gitea/ws-a"]);
    await call("PUT", `/api/runtime-tokens/${t.record.id}`, { allowedConnections: [a, c] });
    expect(await names()).toEqual(["hackernews/default", "gitea/ws-a", "gitea/ws-c"]);
    expect((await call("DELETE", `/api/runtime-tokens/${t.record.id}`)).status).toBe(200);
    expect((await call("POST", "/mcp", { method: "tools/list" }, t.token)).status).toBe(401);
  });

  it("searches by service with a limit and returns the catalog fields", async () => {
    const { tool, mintToken } = setup();
    const t = await mintToken("catalog", []);
    const r = await tool(t.token, "search_actions", {
      query: "file",
      service: "googledrive",
      limit: 2,
    });
    const data = r.structuredContent.data as { id: string; operationType: string }[];
    expect(data).toHaveLength(2);
    expect(data.every((d) => d.id.startsWith("googledrive."))).toBe(true);
    expect(data[0]).toHaveProperty("capability.requiredScopes");
  });

  it("refuses a guide on a connection the token is not granted", async () => {
    const { tool, apiKey, mintToken } = setup();
    const a = (await apiKey("ws-a")).json.id as string;
    await apiKey("ws-b");
    const t = await mintToken("ws", [a]);
    const ok = await tool(t.token, "get_action_guide", {
      actionId: "gitea.get_current_user",
      connectionName: "ws-a",
    });
    expect(ok.structuredContent).toMatchObject({
      ok: true,
      data: { capability: { operationType: "read" } },
    });
    const refused = await tool(t.token, "get_action_guide", {
      actionId: "gitea.get_current_user",
      connectionName: "ws-b",
    });
    expect(refused.structuredContent).toMatchObject({ error: { code: "connection_not_allowed" } });
  });

  it("runs an OAuth grant: config, authorization URL with the saved redirect, callback exchange", async () => {
    const { rt, call } = setup();
    expect(
      (await call("POST", "/api/oauth/authorizations", { service: "slack", connectionName: "x" }))
        .status,
    ).toBe(400);
    const cfg = await call("PUT", "/api/oauth/configs/slack", {
      clientId: "cid",
      clientSecret: "csecret",
      redirectUri: "https://gw.test/api/integrations/oauth/callback",
    });
    expect(cfg.json).toMatchObject({
      expectedRedirectUri: "https://gw.test/api/integrations/oauth/callback",
    });
    const started = await call("POST", "/api/oauth/authorizations", {
      service: "slack",
      connectionName: "wabc-main",
    });
    const url = new URL(started.json.authorizationUrl as string);
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://gw.test/api/integrations/oauth/callback",
    );
    expect(url.searchParams.get("state")).toBe(started.json.state);
    expect((await call("GET", "/oauth/callback?state=bogus&code=x", undefined, "")).json).toEqual({
      error: { code: "invalid_oauth_state", message: "OAuth state is missing or expired." },
    });
    const done = await rt.fetch(`${BASE}/oauth/callback?state=${started.json.state}&code=c1`);
    expect(done.status).toBe(200);
    expect(rt.connection("slack", "wabc-main")?.authType).toBe("oauth2");
    expect(rt.oauthExchanges).toEqual([
      { service: "slack", connectionName: "wabc-main", code: "c1" },
    ]);
  });

  it("answers provider setup for known services only", async () => {
    const { call } = setup();
    expect((await call("GET", "/v1/providers/gitea/setup")).json).toMatchObject({
      data: { service: "gitea", auth: [{ type: "api_key" }] },
    });
    expect((await call("GET", "/v1/providers/nope/setup")).status).toBe(404);
  });
});
