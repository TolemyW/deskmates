// T1: connector registration (ADR-0012 item 8, verification row 8). Registering needs the operator
// listener; the URL and credential go through the Secrets Store, so no column and no response
// holds them; the workspace's egress allowlist is unchanged by registration.

import type { ConnectorRegistration, Workspace } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONNECTOR_CREDENTIAL,
  CONNECTOR_URL,
  TEST_SECRETS_KEY,
} from "../test-support/connector-fixture.js";
import { type Harness, startHarness } from "../test-support/harness.js";

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

async function setup(secretsKey = TEST_SECRETS_KEY) {
  const h = await startHarness({ secretsKey });
  harnesses.push(h);
  const ws = await h.api<{ workspace: Workspace }>("POST", "/api/workspaces", {
    name: "db",
    egressAllowlist: ["ops.example.test"],
  });
  return { h, workspace: ws.json.workspace };
}

describe("connector registration", () => {
  it("needs the operator credential", async () => {
    const { h, workspace } = await setup();
    const res = await fetch(`${h.baseUrl}/api/connectors`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: workspace.id, name: "tickets", url: CONNECTOR_URL }),
    });
    expect(res.status).toBe(401);
  });

  it("stores the URL and credential only encrypted and never returns them", async () => {
    const { h, workspace } = await setup();
    const created = await h.api<{ connector: ConnectorRegistration }>("POST", "/api/connectors", {
      workspaceId: workspace.id,
      name: "tickets",
      kind: "database",
      url: CONNECTOR_URL,
      credential: CONNECTOR_CREDENTIAL,
    });
    expect(created.status).toBe(201);
    expect(created.json.connector).toMatchObject({
      workspaceId: workspace.id,
      name: "tickets",
      kind: "database",
      publicUrl: false,
    });
    const listed = await h.api<{ connectors: ConnectorRegistration[] }>(
      "GET",
      `/api/connectors?workspaceId=${workspace.id}`,
    );
    const one = await h.api<unknown>("GET", `/api/connectors/${created.json.connector.id}`);
    for (const body of [created.json, listed.json, one.json]) {
      const text = JSON.stringify(body);
      expect(text).not.toContain("tickets-db.connector.internal");
      expect(text).not.toContain(CONNECTOR_CREDENTIAL);
    }
    expect(listed.json.connectors.map((c) => c.id)).toEqual([created.json.connector.id]);

    const dump = h.app.deskmates.ctx.db.serialize().toString("latin1");
    expect(dump).not.toContain("tickets-db.connector.internal");
    expect(dump).not.toContain(CONNECTOR_CREDENTIAL);
    // The Gateway itself can still read it back, which is the point of the store.
    expect(h.app.deskmates.ctx.connectors.endpoint(created.json.connector.id)).toEqual({
      url: CONNECTOR_URL,
      credential: CONNECTOR_CREDENTIAL,
    });
  });

  it("leaves the workspace egress allowlist unchanged", async () => {
    const { h, workspace } = await setup();
    await h.api("POST", "/api/connectors", {
      workspaceId: workspace.id,
      name: "tickets",
      url: CONNECTOR_URL,
    });
    expect(h.app.deskmates.ctx.workspaces.mustGet(workspace.id).egressAllowlist).toEqual([
      "ops.example.test",
    ]);
  });

  it("refuses registration without a secrets key, a bad URL, a duplicate name or a private public URL", async () => {
    const noKey = await setup("");
    expect(
      (
        await noKey.h.api("POST", "/api/connectors", {
          workspaceId: noKey.workspace.id,
          name: "tickets",
          url: CONNECTOR_URL,
        })
      ).status,
    ).toBe(400);
    expect(noKey.h.app.deskmates.ctx.connectors.list()).toEqual([]);

    const { h, workspace } = await setup();
    const post = (body: Record<string, unknown>) =>
      h.api<{ code: string }>("POST", "/api/connectors", { workspaceId: workspace.id, ...body });
    expect((await post({ name: "a", url: "ftp://x.test" })).status).toBe(400);
    expect((await post({ name: "a", url: "http://user:pw@x.test" })).status).toBe(400);
    expect((await post({ name: "bad name", url: CONNECTOR_URL })).status).toBe(400);
    expect((await post({ name: "a", url: "http://10.0.0.5", publicUrl: true })).status).toBe(400);
    expect(
      (await post({ name: "a", url: "https://api.example.com", publicUrl: true })).status,
    ).toBe(201);
    expect((await post({ name: "a", url: CONNECTOR_URL })).status).toBe(400);
    expect(
      (
        await h.api("POST", "/api/connectors", {
          workspaceId: "ws_missing",
          name: "b",
          url: CONNECTOR_URL,
        })
      ).status,
    ).toBe(404);
  });
});
