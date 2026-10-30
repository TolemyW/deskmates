// T1: connections are scoped to a workspace (ADR-0013 item 3, Amendment 1). A run in workspace A
// cannot list or execute with workspace B's connection: the Gateway refuses with a typed error
// before the runtime is asked, and the runtime token of A is granted A's connections only, rewritten
// whole on every change and revoked when none remain. Metric: cross-workspace executions, 0.

import type { IntegrationConnectionsResult, IntegrationExecuteResult } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  GITEA_KEY_A,
  GITEA_KEY_B,
  type IntegrationFixture,
  integrationFixture,
} from "../test-support/integration-fixture.js";
import { TrashLifecycle } from "../workspaces/trash-lifecycle.js";

let f: IntegrationFixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

async function setup(): Promise<IntegrationFixture> {
  f = await integrationFixture();
  await f.adopt("gitea");
  await f.apiKey(f.a, "main", GITEA_KEY_A);
  await f.apiKey(f.b, "main", GITEA_KEY_B);
  return f;
}

const tokenOf = (fx: IntegrationFixture, workspaceId: string) =>
  fx.fake.tokenNamed(`deskmates-workspace-${workspaceId}`);

describe("workspace scope of integration connections", () => {
  it("lists only the run's own workspace connections, under the names bots use", async () => {
    const fx = await setup();
    const listed = await fx.run<IntegrationConnectionsResult>(fx.a, "GET", "/connections");
    expect(listed.status).toBe(200);
    expect(listed.json.connections).toEqual([
      { service: "gitea", connectionName: "main", authKind: "api_key", account: "Spike Bot" },
    ]);
    // The runtime lists a no-auth virtual connection too; it never reaches the run.
    expect(JSON.stringify(listed.json)).not.toContain("hackernews");
  });

  it("refuses a connection name that is not the workspace's own before the runtime is asked", async () => {
    const fx = await setup();
    await fx.apiKey(fx.b, "billing", GITEA_KEY_B);
    const before = fx.fake.requests.length;
    const res = await fx.run<{ code: string; message: string }>(fx.a, "POST", "/execute", {
      actionId: "gitea.list_my_repositories",
      connectionName: "billing",
      input: {},
    });
    expect(res.status).toBe(403);
    expect(res.json.code).toBe("integration_connection_not_allowed");
    expect(fx.fake.requests.slice(before).some((r) => r.path === "/mcp")).toBe(false);
    expect(fx.fake.executions).toEqual([]);
  });

  it("executes with the workspace's own connection and credential, never another's", async () => {
    const fx = await setup();
    const res = await fx.run<IntegrationExecuteResult>(fx.a, "POST", "/execute", {
      actionId: "gitea.list_my_repositories",
      connectionName: "main",
      input: { limit: 10 },
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, connectionName: "main", operationType: "read" });
    const [exec] = fx.fake.executions;
    const ownRuntimeId = fx.h.app.deskmates.ctx.integrations
      .listConnections(fx.a.workspace.id)
      .map((c) => c.runtimeConnectionId);
    expect(ownRuntimeId).toContain(exec?.connectionId);
    expect(fx.fake.connections.get(exec?.connectionId ?? "")?.secret).toBe(GITEA_KEY_A);
    expect(exec?.tokenId).toBe(tokenOf(fx, fx.a.workspace.id)?.id);
  });

  it("grants each workspace token exactly its own connections, as the runtime enforces", async () => {
    const fx = await setup();
    const ctx = fx.h.app.deskmates.ctx;
    const idsA = ctx.integrations
      .listConnections(fx.a.workspace.id)
      .map((c) => c.runtimeConnectionId);
    const idsB = ctx.integrations
      .listConnections(fx.b.workspace.id)
      .map((c) => c.runtimeConnectionId);
    expect(tokenOf(fx, fx.a.workspace.id)?.allowedConnections).toEqual(idsA);
    expect(tokenOf(fx, fx.b.workspace.id)?.allowedConnections).toEqual(idsB);
    expect(tokenOf(fx, fx.a.workspace.id)?.allowedActions).toEqual(["gitea.*"]);
  });

  it("rewrites the grant whole on every change and revokes the token when none remain", async () => {
    const fx = await setup();
    const second = await fx.apiKey(fx.a, "second", GITEA_KEY_A);
    const token = tokenOf(fx, fx.a.workspace.id);
    expect(token?.allowedConnections).toHaveLength(2);
    const conns = fx.h.app.deskmates.ctx.integrations.listConnections(fx.a.workspace.id);
    for (const c of conns) {
      const res = await fx.h.api(
        "DELETE",
        `/api/integrations/workspaces/${fx.a.workspace.id}/connections/${c.id}`,
      );
      expect(res.status).toBe(200);
    }
    expect(token?.revoked).toBe(true);
    expect(tokenOf(fx, fx.a.workspace.id)).toBeUndefined();
    expect(fx.fake.connections.get(second.runtimeConnectionId)).toBeUndefined();
    const refused = await fx.run<{ code: string }>(fx.a, "POST", "/execute", {
      actionId: "gitea.list_my_repositories",
      input: {},
    });
    expect(refused.json.code).toBe("integration_connection_not_allowed");
    // B is untouched.
    expect(tokenOf(fx, fx.b.workspace.id)?.revoked).toBe(false);
  });

  it("revokes only the deleted workspace grant and credentials during permanent deletion", async () => {
    const fx = await setup();
    const tokenA = tokenOf(fx, fx.a.workspace.id);
    const tokenB = tokenOf(fx, fx.b.workspace.id);
    const [connectionA] = fx.h.app.deskmates.ctx.integrations.listConnections(fx.a.workspace.id);
    const [connectionB] = fx.h.app.deskmates.ctx.integrations.listConnections(fx.b.workspace.id);
    const trash = new TrashLifecycle(fx.h.app.deskmates.ctx, fx.h.app.deskmates.scheduler);

    await trash.archiveWorkspace(fx.a.workspace.id, "usr_test");
    await trash.deleteWorkspace(fx.a.workspace.id, fx.a.workspace.name, "usr_test", "tnt_default");

    expect(tokenA?.revoked).toBe(true);
    expect(fx.fake.connections.has(connectionA?.runtimeConnectionId ?? "missing")).toBe(false);
    expect(tokenB?.revoked).toBe(false);
    expect(fx.fake.connections.has(connectionB?.runtimeConnectionId ?? "missing")).toBe(true);
  });

  it("keeps a reused name's credential when the old revoked row is revoked again (#61 M12)", async () => {
    const fx = await setup();
    const [old] = fx.h.app.deskmates.ctx.integrations.listConnections(fx.a.workspace.id);
    const path = `/api/integrations/workspaces/${fx.a.workspace.id}/connections/${old?.id}`;
    expect((await fx.h.api("DELETE", path)).status).toBe(200);
    const reused = await fx.apiKey(fx.a, "main", GITEA_KEY_A);
    expect(reused.id).not.toBe(old?.id);
    expect((await fx.h.api("DELETE", path)).status).toBe(200);
    const live = fx.h.app.deskmates.ctx.integrations
      .listConnections(fx.a.workspace.id)
      .find((c) => c.id === reused.id);
    expect(live?.revokedAt).toBeUndefined();
    expect(fx.fake.connections.has(live?.runtimeConnectionId ?? "missing")).toBe(true);
    const res = await fx.run<IntegrationExecuteResult>(fx.a, "POST", "/execute", {
      actionId: "gitea.get_current_user",
      connectionName: "main",
    });
    expect(res.json).toMatchObject({ ok: true, connectionName: "main" });
  });

  it("refuses a revoke of another workspace's connection", async () => {
    const fx = await setup();
    const [ofB] = fx.h.app.deskmates.ctx.integrations.listConnections(fx.b.workspace.id);
    const res = await fx.h.api(
      "DELETE",
      `/api/integrations/workspaces/${fx.a.workspace.id}/connections/${ofB?.id}`,
    );
    expect(res.status).toBe(404);
  });

  it("uses the only connection of the service when none is named, and refuses without one", async () => {
    const fx = await setup();
    const res = await fx.run<IntegrationExecuteResult>(fx.a, "POST", "/execute", {
      actionId: "gitea.get_current_user",
    });
    expect(res.json).toMatchObject({ ok: true, connectionName: "main" });
    await fx.apiKey(fx.a, "other", GITEA_KEY_A);
    const ambiguous = await fx.run<{ code: string }>(fx.a, "POST", "/execute", {
      actionId: "gitea.get_current_user",
    });
    expect(ambiguous.status).toBe(400);
  });

  it("hides the runtime's connection_not_allowed detail if it ever refuses first", async () => {
    const fx = await setup();
    // Simulate a grant drift: the runtime no longer grants A's connection.
    const t = tokenOf(fx, fx.a.workspace.id);
    if (t) t.allowedConnections = ["00000000-0000-0000-0000-000000000000"];
    const res = await fx.run<{ code: string; message: string }>(fx.a, "POST", "/execute", {
      actionId: "gitea.get_current_user",
      connectionName: "main",
    });
    expect(res.json.code).toBe("integration_connection_not_allowed");
    expect(res.json.message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });
});
