import {
  type BotDefinition,
  type Workspace,
  type WorkspaceId,
  isTerminal,
} from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "../test-support/harness.js";
import { seedTenant } from "../test-support/tenants.js";

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  if (h) await h.close();
});

async function workspace(name: string): Promise<{ workspace: Workspace; bot: BotDefinition }> {
  const created = await h.api<{ workspace: Workspace }>("POST", "/api/workspaces", {
    name,
    defaultBot: false,
  });
  const bot = await h.api<{ bot: BotDefinition }>("POST", "/api/bots", {
    name: `${name.toLowerCase()}-bot`,
    workspaceId: created.json.workspace.id,
  });
  return { workspace: created.json.workspace, bot: bot.json.bot };
}

describe("ADR-0026 Trash lifecycle", () => {
  it("archives as a hard stop, hides active rows and restores without starting a sandbox", async () => {
    const item = await workspace("ArchiveMe");
    const archived = await h.api<{ workspace: Workspace }>(
      "POST",
      `/api/workspaces/${item.workspace.id}/archive`,
    );
    expect(archived.status).toBe(200);
    expect(archived.json.workspace.archivedAt).toBeTruthy();
    expect(
      h.app.deskmates.ctx.runs.list({ botId: item.bot.id }).every((run) => isTerminal(run.status)),
    ).toBe(true);
    expect(
      (await h.api<{ workspaces: Workspace[] }>("GET", "/api/workspaces")).json.workspaces,
    ).toEqual([]);
    expect(
      (await h.api<{ workspaces: Workspace[] }>("GET", "/api/trash")).json.workspaces,
    ).toHaveLength(1);
    const createdBeforeRestore = h.provider.created.length;
    expect(h.provider.destroyed).toHaveLength(1);
    expect(() =>
      h.app.deskmates.ctx.runs.create({
        botId: item.bot.id,
        lane: "background",
        triggerKind: "webhook",
        triggerRef: "after-archive",
      }),
    ).toThrow(/trashed/);

    const restored = await h.api<{ workspace: Workspace }>(
      "POST",
      `/api/workspaces/${item.workspace.id}/restore`,
    );
    expect(restored.status).toBe(200);
    expect(restored.json.workspace.archivedAt).toBeUndefined();
    expect(h.provider.created).toHaveLength(createdBeforeRestore);
  });

  it("keeps a trashed workspace's bots out of startup reconciliation and cron", async () => {
    const trashed = await workspace("Trashed");
    const kept = await workspace("Kept");
    const patched = await h.api("PATCH", `/api/bots/${trashed.bot.id}`, {
      cron: [{ schedule: "* * * * *", prompt: "tick" }],
    });
    expect(patched.status).toBe(200);
    const archived = await h.api("POST", `/api/workspaces/${trashed.workspace.id}/archive`);
    expect(archived.status).toBe(200);
    const { ctx } = h.app.deskmates;
    // Archiving marks only the workspace; its bot rows stay active. Gateway startup reconciles
    // private chats over every listed bot, so a listed bot that get() cannot see crashed startup.
    expect(ctx.bots.list().map((bot) => bot.id)).toEqual([kept.bot.id]);
    expect(() => ctx.privateChats.ensureExisting()).not.toThrow();
    const before = ctx.runs.list({ botId: trashed.bot.id }).length;
    h.app.deskmates.cron.tick(new Date());
    expect(ctx.runs.list({ botId: trashed.bot.id })).toHaveLength(before);

    const restored = await h.api("POST", `/api/workspaces/${trashed.workspace.id}/restore`);
    expect(restored.status).toBe(200);
    expect(
      ctx.bots
        .list()
        .map((bot) => bot.id)
        .sort(),
    ).toEqual([trashed.bot.id, kept.bot.id].sort());
    expect(() => ctx.privateChats.ensureExisting()).not.toThrow();
  });

  it("keeps receipt deletion immutable normally but permits one exact confirmed lifecycle delete", async () => {
    const doomed = await workspace("Doomed");
    const peer = await workspace("Peer");
    const run = h.app.deskmates.ctx.runs.list({ botId: doomed.bot.id })[0];
    if (!run) throw new Error("welcome run missing");
    h.app.deskmates.ctx.db
      .prepare(
        "INSERT INTO connectors (id, kind, name, config_json, workspace_id, public_url, created_at) VALUES ('con_doomed', 'postgres', 'db', '{}', ?, 0, 't')",
      )
      .run(doomed.workspace.id);
    h.app.deskmates.ctx.db
      .prepare(
        `INSERT INTO connector_receipts
         (connector_id, receipt_id, workspace_id, run_id, bot_id, content_hash, validation_id, idempotency_key, created_at)
         VALUES ('con_doomed', 'receipt', ?, ?, ?, 'hash', 'validation', 'key', 't')`,
      )
      .run(doomed.workspace.id, run.id, doomed.bot.id);
    h.app.deskmates.ctx.db
      .prepare(
        "INSERT INTO connector_receipt_versions (connector_id, receipt_id, version, status, recorded_at) VALUES ('con_doomed', 'receipt', 1, 'accepted', 't')",
      )
      .run();
    h.app.deskmates.ctx.db
      .prepare(
        `INSERT INTO memory_entries
         (id, workspace_id, bot_id, scope, kind, body, normalized_body, authority, trust,
          source_kind, observed_at, valid_from, created_at, updated_at)
         VALUES ('mem_doomed', ?, ?, 'bot', 'note', 'remember me', 'remember me', 'fact',
                 'trusted', 'human', 't', 't', 't', 't')`,
      )
      .run(doomed.workspace.id, doomed.bot.id);
    h.app.deskmates.ctx.db
      .prepare(
        `INSERT INTO memory_versions
         (entry_id, version, op, body, authority, trust, source_kind, by, created_at)
         VALUES ('mem_doomed', 1, 'create', 'remember me', 'fact', 'trusted', 'human', 'usr_test', 't')`,
      )
      .run();

    expect(() =>
      h.app.deskmates.ctx.db
        .prepare("DELETE FROM connector_receipts WHERE connector_id = 'con_doomed'")
        .run(),
    ).toThrow(/immutable/);
    expect(() =>
      h.app.deskmates.ctx.db
        .prepare("DELETE FROM memory_versions WHERE entry_id = 'mem_doomed'")
        .run(),
    ).toThrow(/immutable/);

    await h.api("POST", `/api/workspaces/${doomed.workspace.id}/archive`);
    const wrong = await h.api<{ code: string }>(
      "DELETE",
      `/api/workspaces/${doomed.workspace.id}`,
      {
        name: "wrong",
      },
    );
    expect(wrong.status).toBe(400);
    const deleted = await h.api("DELETE", `/api/workspaces/${doomed.workspace.id}`, {
      name: doomed.workspace.name,
    });
    expect(deleted.status).toBe(200);
    expect(h.provider.permanentlyDeleted).toContainEqual({
      workspaceId: doomed.workspace.id,
      tenantId: "tnt_default",
    });
    expect(
      h.app.deskmates.ctx.db.prepare("SELECT 1 FROM connector_receipts").get(),
    ).toBeUndefined();
    expect(h.app.deskmates.ctx.db.prepare("SELECT 1 FROM memory_versions").get()).toBeUndefined();
    expect(h.app.deskmates.ctx.workspaces.mustGet(peer.workspace.id).name).toBe("Peer");
    expect(h.app.deskmates.ctx.bots.mustGet(peer.bot.id).name).toBe(peer.bot.name);
    expect(h.app.deskmates.ctx.db.prepare("SELECT * FROM permanent_delete_context").all()).toEqual(
      [],
    );
    expect(h.app.deskmates.ctx.db.prepare("SELECT * FROM deletion_tombstones").all()).toEqual([
      expect.objectContaining({
        object_id: doomed.workspace.id,
        object_kind: "workspace",
        tenant_id: "tnt_default",
      }),
    ]);
  });

  it("permanent delete leaves no orphan in any table (ADR-0031 decision 6)", async () => {
    // The fixture stores connector secrets, so this Gateway has a secrets key.
    const local = await startHarness({ secretsKey: Buffer.alloc(32, 7).toString("base64") });
    const { ctx } = local.app.deskmates;
    const doomed = await seedTenant(ctx, "Purge", "tnt_default");
    const peerWorkspace = ctx.workspaces.create({ name: "Survivor", sandboxProvider: "docker" });
    const peer = {
      bot: ctx.bots.create({ name: "survivor", role: "r", workspaceId: peerWorkspace.id }),
    };
    // A live integration connection needs its external runtime to revoke; none runs here.
    ctx.db
      .prepare("DELETE FROM integration_connections WHERE workspace_id = ?")
      .run(doomed.ids.workspace);
    const name = ctx.workspaces.mustGet(doomed.ids.workspace as WorkspaceId).name;
    expect(
      (await local.api("POST", `/api/workspaces/${doomed.ids.workspace}/archive`)).status,
    ).toBe(200);
    const deleted = await local.api("DELETE", `/api/workspaces/${doomed.ids.workspace}`, {
      name,
    });
    expect(deleted.json).toEqual({ deleted: true });
    const scoped = (
      ctx.db
        .prepare(
          `SELECT m.name FROM sqlite_master m, pragma_table_info(m.name) c
           WHERE m.type = 'table' AND c.name = 'workspace_id' AND m.name <> 'audit_events'`,
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(scoped.length).toBeGreaterThan(20);
    for (const table of scoped)
      expect(
        ctx.db
          .prepare(`SELECT count(*) AS n FROM "${table}" WHERE workspace_id = ?`)
          .get(doomed.ids.workspace),
        table,
      ).toEqual({ n: 0 });
    expect(ctx.db.prepare("SELECT 1 FROM workspaces WHERE id = ?").get(doomed.ids.workspace)).toBe(
      undefined,
    );
    expect(ctx.db.pragma("foreign_key_check")).toEqual([]);
    expect(ctx.bots.mustGet(peer.bot.id).name).toBe(peer.bot.name);
    await local.close();
  });

  it("archives and deletes one bot without touching its peer", async () => {
    const item = await workspace("Bots");
    const peer = await h.api<{ bot: BotDefinition }>("POST", "/api/bots", {
      name: "peer-bot",
      workspaceId: item.workspace.id,
    });
    await h.api("POST", `/api/bots/${item.bot.id}/archive`);
    expect((await h.api<{ bots: BotDefinition[] }>("GET", "/api/bots")).json.bots).toEqual([
      expect.objectContaining({ id: peer.json.bot.id }),
    ]);
    expect((await h.api<{ bots: BotDefinition[] }>("GET", "/api/trash")).json.bots).toEqual([
      expect.objectContaining({ id: item.bot.id }),
    ]);
    const deleted = await h.api("DELETE", `/api/bots/${item.bot.id}`, { name: item.bot.name });
    expect(deleted.status).toBe(200);
    expect(h.app.deskmates.ctx.bots.mustGet(peer.json.bot.id).id).toBe(peer.json.bot.id);
  });

  it("pages archived workspaces with an honest total and a stable tie-breaker (#113)", async () => {
    const ctx = h.app.deskmates.ctx;
    const ids: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const created = await h.api<{ workspace: Workspace }>("POST", "/api/workspaces", {
        defaultBot: false,
        name: `Old ${i}`,
      });
      ids.push(created.json.workspace.id);
    }
    // Equal archive times: the id decides the order.
    ctx.db
      .prepare("UPDATE workspaces SET archived_at = ? WHERE id IN (SELECT value FROM json_each(?))")
      .run("2026-10-13T00:00:00.000Z", JSON.stringify(ids));
    type Page = { workspaces: Workspace[]; offset: number; limit: number; total: number };
    const seen: string[] = [];
    for (const offset of [0, 3, 6]) {
      const page = (await h.api<Page>("GET", `/api/trash?offset=${offset}&limit=3`)).json;
      expect(page).toMatchObject({ offset, limit: 3, total: 7 });
      seen.push(...page.workspaces.map((w) => w.id));
    }
    expect(seen).toEqual([...ids].sort());
    expect((await h.api<Page>("GET", "/api/trash?offset=9&limit=3")).json).toMatchObject({
      workspaces: [],
      total: 7,
    });
    expect((await h.api("GET", "/api/trash?limit=101")).status).toBe(400);
    expect((await h.api("GET", "/api/trash?offset=-3")).status).toBe(400);
  });
});
