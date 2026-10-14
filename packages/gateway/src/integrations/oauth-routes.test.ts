// T1: OAuth grants through Gateway routes (ADR-0013 item 4, Amendment 1 topology B). The operator
// gives the runtime an OAuth app redirecting to the Gateway's callback, starts a grant for one
// workspace and gets the provider's authorization URL; the callback, authenticated only by the
// one-time state, forwards code and state to the runtime and records the connection for the
// workspace the state was issued for. The Gateway database keeps ids and names only.

import type { IntegrationConnection } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  CALLBACK_URL,
  type IntegrationFixture,
  integrationFixture,
} from "../test-support/integration-fixture.js";

const CLIENT_SECRET = "slack-client-secret-do-not-store-9a0b";
const CODE = "provider-code-do-not-store-1c2d";

let f: IntegrationFixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

async function setup(callbackUrl?: string | null): Promise<IntegrationFixture> {
  f = await integrationFixture(callbackUrl === undefined ? {} : { callbackUrl });
  await f.adopt("slack");
  return f;
}

async function configureApp(fx: IntegrationFixture) {
  return fx.h.api<{ redirectUri: string }>("PUT", "/api/integrations/providers/slack/oauth-app", {
    clientId: "slack-client",
    clientSecret: CLIENT_SECRET,
    requestedScopes: ["chat:write"],
  });
}

async function start(fx: IntegrationFixture, workspaceId: string, name = "team") {
  return fx.h.api<{ authorizationUrl: string; code?: string }>(
    "POST",
    `/api/integrations/workspaces/${workspaceId}/connections/oauth/start`,
    { service: "slack", connectionName: name },
  );
}

/** The browser following the provider's redirect: no Bearer header. */
function callback(fx: IntegrationFixture, query: string): Promise<Response> {
  return fetch(`${fx.h.baseUrl}/api/integrations/oauth/callback?${query}`);
}

describe("OAuth grant routes", () => {
  it("gives the runtime the OAuth app with this Gateway's callback as redirect URI", async () => {
    const fx = await setup();
    const res = await configureApp(fx);
    expect(res.status).toBe(200);
    expect(res.json.redirectUri).toBe(CALLBACK_URL);
    expect(fx.fake.oauthConfigs.get("slack")?.redirectUri).toBe(CALLBACK_URL);
    expect(JSON.stringify(res.json)).not.toContain(CLIENT_SECRET);
  });

  it("returns an authorization URL that redirects to our callback, and records the workspace on completion", async () => {
    const fx = await setup();
    await configureApp(fx);
    const started = await start(fx, fx.a.workspace.id);
    expect(started.status).toBe(200);
    const url = new URL(started.json.authorizationUrl);
    expect(url.searchParams.get("redirect_uri")).toBe(CALLBACK_URL);
    const state = url.searchParams.get("state") as string;

    const done = await callback(fx, `code=${CODE}&state=${state}`);
    expect(done.status).toBe(200);
    expect(done.headers.get("content-type")).toContain("text/html");
    expect(await done.text()).toContain("Connected slack as team");
    expect(fx.fake.oauthExchanges).toHaveLength(1);
    expect(fx.fake.oauthExchanges[0]?.code).toBe(CODE);

    const listed = await fx.h.api<{ connections: IntegrationConnection[] }>(
      "GET",
      `/api/integrations/workspaces/${fx.a.workspace.id}/connections`,
    );
    expect(listed.json.connections).toMatchObject([
      {
        service: "slack",
        connectionName: "team",
        authKind: "oauth",
        workspaceId: fx.a.workspace.id,
      },
    ]);
    const ofB = await fx.h.api<{ connections: IntegrationConnection[] }>(
      "GET",
      `/api/integrations/workspaces/${fx.b.workspace.id}/connections`,
    );
    expect(ofB.json.connections).toEqual([]);

    // Replaying the callback is refused: the state was spent.
    expect((await callback(fx, `code=${CODE}&state=${state}`)).status).toBe(401);

    const dump = fx.h.app.deskmates.ctx.db.serialize().toString("latin1");
    for (const secret of [CODE, state, CLIENT_SECRET, "oauth-access-"])
      expect(dump).not.toContain(secret);
  });

  it("refuses a callback without a known state and never forwards it", async () => {
    const fx = await setup();
    const before = fx.fake.requests.length;
    for (const q of ["code=x", "state=bogus&code=x", ""]) {
      const res = await callback(fx, q);
      expect(res.status, q).toBe(401);
    }
    expect(fx.fake.requests.slice(before).some((r) => r.path === "/oauth/callback")).toBe(false);
  });

  it("reports a denied grant and records nothing", async () => {
    const fx = await setup();
    await configureApp(fx);
    const state = new URL(
      (await start(fx, fx.a.workspace.id)).json.authorizationUrl,
    ).searchParams.get("state");
    const res = await callback(fx, `error=access_denied&state=${state}`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("oauth_provider_error");
    expect(fx.h.app.deskmates.ctx.integrations.listConnections(fx.a.workspace.id)).toEqual([]);
  });

  it("refuses to start a grant whose app redirects elsewhere, or without a callback URL", async () => {
    const fx = await setup();
    // An app configured on the runtime directly, pointing at the runtime's own callback.
    fx.fake.oauthConfigs.set("slack", { clientId: "c" });
    const res = await start(fx, fx.a.workspace.id);
    expect(res.status).toBe(400);
    await fx.close();

    f = await integrationFixture({ callbackUrl: null });
    await f.adopt("slack");
    expect((await configureApp(f)).status).toBe(503);
    expect((await start(f, f.a.workspace.id)).status).toBe(503);
  });

  it("refuses OAuth for a provider that has none, and a provider that is not adopted", async () => {
    const fx = await setup();
    await fx.adopt("gitea");
    expect(
      (
        await fx.h.api(
          "POST",
          `/api/integrations/workspaces/${fx.a.workspace.id}/connections/oauth/start`,
          {
            service: "gitea",
            connectionName: "x",
          },
        )
      ).status,
    ).toBe(400);
    const notAdopted = await fx.h.api<{ code: string }>(
      "POST",
      `/api/integrations/workspaces/${fx.a.workspace.id}/connections/oauth/start`,
      { service: "googledrive", connectionName: "x" },
    );
    expect(notAdopted.json.code).toBe("integration_not_adopted");
  });
});
