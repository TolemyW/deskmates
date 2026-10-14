// T1: the Integrations lists page on the server (#113, pagination coverage surfaces 8 and 9).
// Connections and connectors come one offset page at a time, oldest first with the id as
// tie-breaker, with the honest total; a limit over the maximum or a bad offset is 400, never
// clamped; and the per-service live counts come from the whole workspace, never from the page.

import type { ConnectorPage, IntegrationConnectionPage, Workspace } from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "../test-support/harness.js";

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

const AT = "2026-10-14T00:00:00.000Z";

async function workspace(name: string): Promise<Workspace> {
  return (await h.api<{ workspace: Workspace }>("POST", "/api/workspaces", { name })).json
    .workspace;
}

function connection(workspaceId: string, id: string, service: string, revoked = false): void {
  h.app.deskmates.ctx.db
    .prepare(
      `INSERT INTO integration_connections (id, workspace_id, service, connection_name,
         runtime_connection_name, runtime_connection_id, auth_kind, created_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, 'api_key', ?, ?)`,
    )
    .run(id, workspaceId, service, id, `rt-${id}`, `rt-${id}`, AT, revoked ? AT : null);
}

function connector(workspaceId: string, id: string): void {
  h.app.deskmates.ctx.db
    .prepare(
      "INSERT INTO connectors (id, workspace_id, kind, name, created_at) VALUES (?, ?, 'database', ?, ?)",
    )
    .run(id, workspaceId, id, AT);
}

describe("Integrations pages (#113)", () => {
  it("pages connectors with an honest total and the id as tie-breaker", async () => {
    const ws = await workspace("db");
    const other = await workspace("other");
    const ids = ["con_g", "con_c", "con_a", "con_f", "con_b", "con_e", "con_d"];
    for (const id of ids) connector(ws.id, id);
    connector(other.id, "con_other");
    const seen: string[] = [];
    for (const offset of [0, 3, 6]) {
      const page = (
        await h.api<ConnectorPage>(
          "GET",
          `/api/connectors?workspaceId=${ws.id}&offset=${offset}&limit=3`,
        )
      ).json;
      expect(page).toMatchObject({ offset, limit: 3, total: 7 });
      seen.push(...page.connectors.map((c) => c.id));
    }
    expect(seen).toEqual([...ids].sort());
    const past = await h.api<ConnectorPage>(
      "GET",
      `/api/connectors?workspaceId=${ws.id}&offset=9&limit=3`,
    );
    expect(past.json).toMatchObject({ connectors: [], total: 7 });
    // An unpaged request gets the first page, never the whole collection.
    const first = await h.api<ConnectorPage>("GET", `/api/connectors?workspaceId=${ws.id}`);
    expect(first.json).toMatchObject({ offset: 0, limit: 25, total: 7 });
    expect((await h.api("GET", `/api/connectors?workspaceId=${ws.id}&limit=101`)).status).toBe(400);
    expect((await h.api("GET", `/api/connectors?workspaceId=${ws.id}&offset=-1`)).status).toBe(400);
  });

  it("pages connections and counts live ones per service from the whole workspace", async () => {
    const ws = await workspace("apps");
    const other = await workspace("other");
    for (const [id, service] of [
      ["icn_e", "github"],
      ["icn_a", "slack"],
      ["icn_d", "github"],
      ["icn_b", "github"],
      ["icn_c", "slack"],
    ] as const)
      connection(ws.id, id, service);
    connection(ws.id, "icn_r1", "github", true);
    connection(ws.id, "icn_r2", "notion", true);
    connection(other.id, "icn_x", "github");
    const base = `/api/integrations/workspaces/${ws.id}/connections`;
    const seen: string[] = [];
    for (const offset of [0, 2, 4]) {
      const page = (
        await h.api<IntegrationConnectionPage>(
          "GET",
          `${base}?status=live&offset=${offset}&limit=2`,
        )
      ).json;
      expect(page).toMatchObject({ offset, limit: 2, total: 5 });
      // The same whole-workspace counts on every page, revoked and foreign rows excluded.
      expect(page.liveByService).toEqual([
        { service: "github", count: 3 },
        { service: "slack", count: 2 },
      ]);
      seen.push(...page.connections.map((c) => c.id));
    }
    expect(seen).toEqual(["icn_a", "icn_b", "icn_c", "icn_d", "icn_e"]);
    const all = (await h.api<IntegrationConnectionPage>("GET", base)).json;
    expect(all).toMatchObject({ offset: 0, limit: 25, total: 7 });
    const revoked = (await h.api<IntegrationConnectionPage>("GET", `${base}?status=revoked`)).json;
    expect(revoked.connections.map((c) => c.id)).toEqual(["icn_r1", "icn_r2"]);
    const past = (await h.api<IntegrationConnectionPage>("GET", `${base}?status=live&offset=6`))
      .json;
    expect(past).toMatchObject({ connections: [], total: 5 });
    expect((await h.api("GET", `${base}?limit=101`)).status).toBe(400);
    expect((await h.api("GET", `${base}?limit=0`)).status).toBe(400);
    expect((await h.api("GET", `${base}?status=gone`)).status).toBe(400);
  });
});
