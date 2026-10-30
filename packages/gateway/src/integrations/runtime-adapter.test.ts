// T1: the runtime adapter against the testkit fake runtime (ADR-0013 verification row 2). The
// same calls work whether MCP answers in JSON or in v1.7.0's one-event SSE body; transport and
// protocol failures become the typed errors of contracts; a refusal inside a tool result stays a
// refusal, not a transport error.

import { createServer } from "node:http";
import { DeskmatesError } from "@deskmates/contracts";
import { FakeIntegrationRuntime } from "@deskmates/testkit";
import { describe, expect, it } from "vitest";
import { RuntimeAdapter, RuntimeToolError } from "./runtime-adapter.js";

const URL_ = "http://runtime.internal:3000/prefix";

function setup(mcpResponse: "sse" | "json" = "sse") {
  const fake = new FakeIntegrationRuntime({ baseUrl: URL_, adminToken: "adm", mcpResponse });
  const adapter = new RuntimeAdapter({ url: URL_, adminToken: "adm", fetch: fake.fetch });
  return { fake, adapter };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "resolved";
  } catch (err) {
    return err instanceof DeskmatesError
      ? err.code
      : err instanceof RuntimeToolError
        ? `tool:${err.code}`
        : "other";
  }
}

describe("runtime adapter", () => {
  it("reads raw full definitions and rejects identity or schema envelope mismatches", async () => {
    const definition = {
      id: "googledrive.files.get",
      service: "googledrive",
      operationType: "read",
      requiredScopes: ["https://www.googleapis.com/auth/drive.readonly"],
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    };
    let body: unknown = definition;
    const adapter = new RuntimeAdapter({
      url: URL_,
      adminToken: "synthetic-admin",
      fetch: async (url) => {
        expect(String(url)).toBe(`${URL_}/api/actions/googledrive.files.get`);
        return Response.json(body);
      },
    });
    expect(await adapter.actionDefinition(definition.id)).toEqual(definition);
    for (const invalid of [
      { ...definition, service: "gmail" },
      { ...definition, inputSchema: [] },
      { data: definition },
    ]) {
      body = invalid;
      expect(await codeOf(adapter.actionDefinition(definition.id))).toBe("integration_protocol");
    }
  });
  it.each(["sse", "json"] as const)(
    "drives the five meta-tools with a scoped token (%s)",
    async (mode) => {
      const { fake, adapter } = setup(mode);
      const conn = await adapter.putApiKeyConnection("gitea", "w1-main", {
        apiKey: "k",
        baseUrl: "x",
      });
      const { token } = await adapter.createToken("ws", {
        allowedConnections: [conn.id],
        allowedActions: ["gitea.*"],
      });
      const listed = await adapter.listConnections(token);
      expect(listed.map((c) => `${c.connectionName}:${c.virtual}`)).toEqual([
        "default:true",
        "w1-main:false",
      ]);
      const found = await adapter.searchActions(token, {
        service: "gitea",
        query: "repositories",
        limit: 5,
      });
      expect(found[0]).toMatchObject({
        actionId: "gitea.list_my_repositories",
        operationType: "read",
        inputs: [{ name: "limit", required: false, type: "integer" }],
      });
      const guide = await adapter.actionGuide(token, "gitea.list_my_repositories", "w1-main");
      expect(guide.operationType).toBe("read");
      expect(guide.markdown).toContain("w1-main");
      const out = await adapter.executeAction(token, "gitea.list_my_repositories", "w1-main", {});
      expect(out).toMatchObject({ ok: true, executionId: fake.executions[0]?.executionId });
      const refused = await adapter.executeAction(token, "gitea.list_my_repositories", "other", {});
      expect(refused).toMatchObject({ ok: false, error: { code: "authorization_failed" } });
    },
  );

  it("rewrites and revokes tokens and deletes connections idempotently", async () => {
    const { fake, adapter } = setup();
    const t = await adapter.createToken("ws", { allowedConnections: ["a"], allowedActions: [] });
    await adapter.updateToken(t.id, "ws", { allowedConnections: ["b", "c"], allowedActions: [] });
    expect(fake.tokens.get(t.id)?.allowedConnections).toEqual(["b", "c"]);
    await adapter.revokeToken(t.id);
    await adapter.revokeToken(t.id);
    expect(fake.tokens.get(t.id)?.revoked).toBe(true);
    await adapter.deleteConnection("gitea", "never-existed");
  });

  it("maps runtime failures to typed errors", async () => {
    const { fake, adapter } = setup();
    expect(await adapter.providerAuthTypes("gitea")).toEqual(["api_key"]);
    expect(await adapter.providerAuthTypes("nope")).toBeUndefined();
    expect(await codeOf(adapter.putApiKeyConnection("gitea", "bad/name", { apiKey: "k" }))).toBe(
      "validation",
    );
    const wrongAdmin = new RuntimeAdapter({ url: URL_, adminToken: "wrong", fetch: fake.fetch });
    expect(await codeOf(wrongAdmin.listAllConnections())).toBe("integration_unavailable");
    expect(await codeOf(adapter.listConnections("oct_unknown"))).toBe("integration_unavailable");
    fake.setAvailable(false);
    expect(await codeOf(adapter.listAllConnections())).toBe("integration_unavailable");
    const garbage = new RuntimeAdapter({
      url: URL_,
      adminToken: "adm",
      fetch: async () =>
        new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }),
    });
    expect(await codeOf(garbage.listConnections("t"))).toBe("integration_protocol");
    expect(await codeOf(garbage.listAllConnections())).toBe("integration_protocol");
    // A reverse proxy's HTML error page is the runtime being unavailable (#61 L13).
    const proxyError = (status: number) =>
      new RuntimeAdapter({
        url: URL_,
        adminToken: "adm",
        fetch: async () =>
          new Response("<html>Bad Gateway</html>", {
            status,
            headers: { "content-type": "text/html" },
          }),
      });
    expect(await codeOf(proxyError(502).listAllConnections())).toBe("integration_unavailable");
    expect(await codeOf(proxyError(503).deleteConnection("gitea", "x"))).toBe(
      "integration_unavailable",
    );
    expect(await codeOf(proxyError(403).listAllConnections())).toBe("integration_unavailable");
    await proxyError(404).deleteConnection("gitea", "x");
  });

  it("forwards the OAuth callback query and reports the runtime's verdict", async () => {
    const { adapter } = setup();
    expect(await adapter.completeOAuth(new URLSearchParams({ state: "bogus", code: "x" }))).toEqual(
      {
        ok: false,
        code: "invalid_oauth_state",
      },
    );
    await adapter.putOAuthApp("slack", {
      clientId: "c",
      clientSecret: "s",
      redirectUri: "https://gw/cb",
    });
    const started = await adapter.startOAuth("slack", "w1-team");
    expect(new URL(started.authorizationUrl).searchParams.get("redirect_uri")).toBe(
      "https://gw/cb",
    );
    expect(
      await adapter.completeOAuth(new URLSearchParams({ state: started.state, code: "c1" })),
    ).toEqual({ ok: true });
    expect((await adapter.listAllConnections()).some((c) => c.connectionName === "w1-team")).toBe(
      true,
    );
  });
});

describe("runtime protocol and transit failures stay isolated", () => {
  it.each(["mcp", "transit"] as const)(
    "keeps the deadline active after headers for a stalled %s response body",
    async (kind) => {
      let requests = 0;
      let headersReceived = false;
      const server = createServer((_request, response) => {
        requests++;
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.write("partial"); // Never end: the deadline must cover body consumption too.
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("listener unavailable");
        const base = `http://127.0.0.1:${address.port}`;
        const adapter = new RuntimeAdapter({
          url: base,
          adminToken: "synthetic-admin",
          timeoutMs: 1000,
          fetch: async (input, init) => {
            const response = await fetch(input, init);
            headersReceived = true;
            return response;
          },
        });
        const result =
          kind === "mcp"
            ? adapter.listConnections("synthetic-workspace-token")
            : adapter.downloadTransit(`${base}/api/files/0123456789abcdef0123456789abcdef.txt`);
        expect(await codeOf(result)).toBe("integration_unavailable");
        expect(headersReceived).toBe(true);
        expect(requests).toBe(1);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );

  it.each([
    { jsonrpc: "2.0", id: 999, result: { structuredContent: { ok: true, data: [] } } },
    { jsonrpc: "2.0", id: 1, result: { isError: true, structuredContent: { data: [] } } },
  ])("rejects mismatched/error MCP envelopes", async (body) => {
    const adapter = new RuntimeAdapter({
      url: URL_,
      adminToken: "adm",
      fetch: async () => Response.json(body),
    });
    expect(await codeOf(adapter.listConnections("t"))).toBe("integration_protocol");
  });

  it("preserves the execution receipt on a provider refusal", async () => {
    const adapter = new RuntimeAdapter({
      url: URL_,
      adminToken: "adm",
      fetch: async () =>
        Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            structuredContent: {
              ok: false,
              executionId: "failed-execution",
              error: { code: "refresh_failed", message: "Reconnect" },
            },
          },
        }),
    });
    expect(await adapter.executeAction("t", "googledrive.files.get", "scratch", {})).toMatchObject({
      ok: false,
      executionId: "failed-execution",
      error: { code: "refresh_failed" },
    });
  });

  it("downloads bounded bytes from only the runtime file store, without credentials or redirects", async () => {
    const calls: RequestInit[] = [];
    const adapter = new RuntimeAdapter({
      url: URL_,
      adminToken: "private-admin",
      fetch: async (_url, init) => {
        calls.push(init ?? {});
        return new Response("synthetic artifact");
      },
    });
    for (const url of [
      "https://evil.test/api/files/id",
      `${URL_}/api/connections`,
      `${URL_}/api/files/a/b`,
      `${URL_}/api/files/id?token=x`,
      `${URL_}/api/files/%2e%2e`,
    ])
      expect(await codeOf(adapter.downloadTransit(url))).toBe("integration_protocol");
    expect(calls).toHaveLength(0);
    expect(
      new TextDecoder().decode(
        await adapter.downloadTransit(`${URL_}/api/files/0123456789abcdef0123456789abcdef.txt`),
      ),
    ).toBe("synthetic artifact");
    expect(new Headers(calls[0]?.headers).has("authorization")).toBe(false);
    expect(calls[0]?.redirect).toBe("manual");
    expect(
      await codeOf(
        adapter.downloadTransit(`${URL_}/api/files/0123456789abcdef0123456789abcdef.txt`, 2),
      ),
    ).toBe("payload_too_large");
  });

  it.each([302, 403, 404, 503])("does not follow or retry transit HTTP %s", async (status) => {
    let calls = 0;
    const adapter = new RuntimeAdapter({
      url: URL_,
      adminToken: "adm",
      fetch: async () => {
        calls++;
        return new Response(null, { status, headers: { location: "https://evil.test" } });
      },
    });
    expect(
      await codeOf(
        adapter.downloadTransit(`${URL_}/api/files/0123456789abcdef0123456789abcdef.txt`),
      ),
    ).toBe("integration_unavailable");
    expect(calls).toBe(1);
  });

  it("maps interrupted response bodies without leaking transport details", async () => {
    const adapter = new RuntimeAdapter({
      url: URL_,
      adminToken: "adm",
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("private transport detail"));
            },
          }),
        ),
    });
    expect(await codeOf(adapter.listConnections("t"))).toBe("integration_unavailable");
    expect(
      await codeOf(
        adapter.downloadTransit(`${URL_}/api/files/0123456789abcdef0123456789abcdef.txt`),
      ),
    ).toBe("integration_unavailable");
  });
});

it("drops catalog entries with a mismatched service/action identity", async () => {
  const adapter = new RuntimeAdapter({
    url: URL_,
    adminToken: "adm",
    fetch: async () =>
      Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: {
          structuredContent: {
            ok: true,
            data: [
              { id: "googledrive.files.create", service: "slack", operationType: "read" },
              { id: "slack.post_message", service: "googledrive", operationType: "read" },
            ],
          },
        },
      }),
  });
  expect(await adapter.searchActions("t", { service: "googledrive", limit: 5 })).toEqual([]);
});
