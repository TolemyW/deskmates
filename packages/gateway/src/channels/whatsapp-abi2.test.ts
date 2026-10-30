// T1, ADR-0047 amendment 1: the release WhatsApp plugin moves to ChannelPlugin ABI 2 in place.
// A database holding ABI-1 WhatsApp connections, bound threads and messages is upgraded by the
// forward migration and restored by a WhatsApp-shaped ABI-2 plugin: the connection keeps its
// Bot, secret, state directory and threads; the next message of a known conversation lands in
// its old thread; inbound and outbound pass the connection-scoped host; a stale handle has no
// effect; a second connection in the workspace and a second claim of one number are refused.
// Since ADR-0017 amendment 3 the stored allowlists are dropped by a later migration, nobody is
// blocked, an unknown sender is admitted and a blocked one gets nothing in either direction; an
// allowlist-declaring variant of the fake keeps the contract's allowlist mode (amendment 1 A2)
// covered. Moving a workspace to Trash stops its QR connection and keeps the link for a restore,
// also across a Gateway restart (amendment 1 P6). The plugin's own half is
// `packages/channels/src/whatsapp/plugin.test.ts`.

import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ApprovalId,
  type BotId,
  CHANNEL_PHASE_ARCHIVED,
  type ChannelCloseReason,
  type ChannelConfigField,
  type ChannelConnectionHost,
  type ChannelOpenRequest,
  type ChannelPluginV2,
  type RunId,
  type ThreadId,
  type WorkspaceId,
  channelManifestV2Problems,
} from "@deskmates/contracts";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, listMigrationFiles } from "../db/migrate.js";
import { SecretsStore } from "../secrets/secrets-store.js";
import { CHANNEL_SECRETS_KEY } from "../test-support/channel-connections.js";
import { type Harness, startHarness } from "../test-support/harness.js";
import { TrashLifecycle } from "../workspaces/trash-lifecycle.js";

const MIGRATIONS = fileURLToPath(new URL("../../migrations/", import.meta.url));
const UPGRADE = "202610171305-whatsapp-channel-abi2.sql";
const at = "2026-10-17T00:00:00.000Z";
const LINKED = "15550001111";
const PERSON = "15550002222";
const CLOUD_PERSON = "15550003333";
const STRANGER = "15559999999";

/**
 * A plugin with WhatsApp's ABI-2 manifest; it claims what the test tells it on every open.
 * `allowlist` declares amendment 1 A2's allowlist mode instead, which no release plugin uses
 * since ADR-0017 amendment 3, to keep that mode of the host covered.
 */
function whatsappShaped(
  claims: Map<string, string>,
  admission: "blocklist" | "allowlist" = "blocklist",
) {
  const listed: ChannelConfigField[] =
    admission === "allowlist"
      ? [{ key: "allowedSenders", label: "Allowed", kind: "phone-list" }]
      : [];
  const hosts = new Map<string, ChannelConnectionHost>();
  const opens: ChannelOpenRequest[] = [];
  const closes: { connectionId: string; reason: ChannelCloseReason }[] = [];
  const refusals: { connectionId: string; code: string }[] = [];
  const plugin: ChannelPluginV2 = {
    manifest: {
      apiVersion: 2,
      id: "whatsapp",
      version: "2.0.0",
      displayName: "WhatsApp",
      description: "Connect one WhatsApp account to one default Bot.",
      multipleConnections: false,
      senderAdmission:
        admission === "allowlist"
          ? { mode: "allowlist", field: "allowedSenders" }
          : { mode: "blocklist" },
      capabilities: {
        directMessages: "available",
        groups: "unavailable",
        inboundImages: "disabled",
        inboundOtherMedia: "disabled",
        outboundReply: "available",
        proactiveMessages: "unavailable",
        streaming: "unavailable",
        approvals: "available",
        testMessage: "available",
      },
      statusVocabulary: ["connected", "qr", "error"],
      methods: [
        {
          id: "qr",
          label: "QR",
          description: "x",
          identity: "link",
          fields: listed,
        },
        {
          id: "cloud",
          label: "Cloud",
          description: "x",
          fields: [
            { key: "phoneNumberId", label: "Phone number ID", kind: "text", required: true },
            ...listed,
          ],
        },
      ],
    },
    create: async () => ({
      verify: async (request) => ({
        identityKey: `whatsapp:cloud:${String(request.config.phoneNumberId)}`,
        label: String(request.config.phoneNumberId),
      }),
      open: async (request, host) => {
        opens.push(request);
        hosts.set(request.connectionId, host);
        const claim = claims.get(request.connectionId);
        if (claim)
          try {
            await host.claimIdentity?.({ identityKey: claim, label: claim });
          } catch (error) {
            refusals.push({
              connectionId: request.connectionId,
              code: String((error as { code?: string }).code),
            });
            return { phase: "error" };
          }
        return { phase: "connected" };
      },
      close: async (connectionId, reason) => {
        closes.push({ connectionId, reason });
        hosts.delete(connectionId);
      },
      status: async () => ({ phase: "connected" }),
      test: async () => ({ phase: "connected" }),
      webhook: async () => ({ status: 200 }),
      stop: async () => {},
    }),
  };
  return { plugin, hosts, opens, closes, refusals };
}

const dirs: string[] = [];
let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A database as an ABI-1 release left it: two workspaces, a QR and a Cloud API connection. */
function legacyDatabase(root: string): { path: string; secretId: string } {
  const before = join(root, "migrations");
  mkdirSync(before);
  for (const name of listMigrationFiles(MIGRATIONS).filter((n) => n < UPGRADE))
    copyFileSync(join(MIGRATIONS, name), join(before, name));
  const path = join(root, "gateway.db");
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  applyMigrations(db, before);
  const tenant = (db.prepare("SELECT id FROM tenants LIMIT 1").get() as { id: string }).id;
  const workspace = db.prepare(
    "INSERT INTO workspaces (id, tenant_id, name, sandbox_provider, status, created_at) VALUES (?, ?, ?, 'docker', 'ready', ?)",
  );
  const bot = db.prepare(
    "INSERT INTO bots (id, workspace_id, name, role, created_at) VALUES (?, ?, ?, 'r', ?)",
  );
  for (const [ws, b, name] of [
    ["ws_a", "bot_a", "alice"],
    ["ws_b", "bot_b", "bea"],
    ["ws_c", "bot_c", "cid"],
  ] as const) {
    workspace.run(ws, tenant, ws, at);
    bot.run(b, ws, name, at);
  }
  // The QR method's proxy URL, encrypted as the ABI-1 connect stored it.
  const secretId = new SecretsStore(db, CHANNEL_SECRETS_KEY).put(
    "workspace",
    "ws_a",
    JSON.stringify({ proxyUrl: "http://proxy.example.test:3128" }),
  );
  const connection = db.prepare(
    `INSERT INTO channel_connections (id, workspace_id, plugin_id, plugin_version, method, bot_id,
       config_json, secret_id, phase, account, created_at, updated_at)
     VALUES (?, ?, 'whatsapp', '1.0.0', ?, ?, ?, ?, 'connected', ?, ?, ?)`,
  );
  connection.run(
    "chn_qr",
    "ws_a",
    "qr",
    "bot_a",
    JSON.stringify({ allowedSenders: PERSON }),
    secretId,
    LINKED,
    at,
    at,
  );
  connection.run(
    "chn_cl",
    "ws_b",
    "cloud",
    "bot_b",
    JSON.stringify({ phoneNumberId: "1234", allowedSenders: CLOUD_PERSON }),
    null,
    "1234",
    at,
    at,
  );
  const thread = db.prepare(
    `INSERT INTO threads (id, workspace_id, kind, channel, external_key, title, turn_budget, status,
       created_at, updated_at) VALUES (?, ?, 'chat', ?, ?, ?, 0, 'active', ?, ?)`,
  );
  thread.run("thr_qr", "ws_a", "whatsapp", `web:${LINKED}:${PERSON}`, `WhatsApp ${PERSON}`, at, at);
  thread.run("thr_cl", "ws_b", "whatsapp", `1234:${CLOUD_PERSON}`, "WhatsApp", at, at);
  thread.run("thr_web", "ws_a", "web", null, "web chat", at, at);
  const member = db.prepare(
    "INSERT INTO thread_members (thread_id, bot_id, joined_at) VALUES (?, ?, ?)",
  );
  member.run("thr_qr", "bot_a", at);
  member.run("thr_cl", "bot_b", at);
  member.run("thr_web", "bot_a", at);
  const message = db.prepare(
    `INSERT INTO thread_messages (id, thread_id, seq, author_kind, author_id, body, external_id, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  message.run("msg_1", "thr_qr", 1, "human", `whatsapp:${PERSON}`, "hello", `web:${LINKED}:m1`, at);
  message.run("msg_2", "thr_qr", 2, "bot", "bot_a", "hi back", null, at);
  db.close();
  return { path, secretId };
}

async function upgraded(
  claims: Map<string, string>,
  admission: "blocklist" | "allowlist" = "blocklist",
) {
  const root = mkdtempSync(join(tmpdir(), "deskmates-wa-abi2-"));
  dirs.push(root);
  const { path: dbPath, secretId } = legacyDatabase(root);
  const stateRoot = join(root, "channels");
  // The QR connection's private state, as the ABI-1 plugin left it.
  const qrState = join(stateRoot, "ws_a", "whatsapp", "chn_qr");
  mkdirSync(qrState, { recursive: true, mode: 0o700 });
  chmodSync(qrState, 0o700);
  writeFileSync(join(qrState, "session.json"), "{}", { mode: 0o600 });
  const fake = whatsappShaped(claims, admission);
  harness = await startHarness(
    { dbPath, channelStateDir: stateRoot, secretsKey: CHANNEL_SECRETS_KEY },
    undefined,
    { channelPlugins: new Map([["whatsapp", fake.plugin]]) },
  );
  // Runs woken by channel messages stay live; the harness closes them.
  harness.provider.onRun(() => new Promise(() => {}));
  return { ...fake, ctx: harness.app.deskmates.ctx, qrState, secretId, dbPath, stateRoot };
}

const CLAIMS = () =>
  new Map([
    ["chn_qr", `whatsapp:linked:${LINKED}`],
    ["chn_cl", "whatsapp:cloud:1234"],
  ]);

describe("WhatsApp on ChannelPlugin ABI 2 (ADR-0047 amendment 1)", { timeout: 30_000 }, () => {
  it("has loadable manifests in this test", () => {
    expect(channelManifestV2Problems(whatsappShaped(new Map()).plugin.manifest)).toEqual([]);
    expect(
      channelManifestV2Problems(whatsappShaped(new Map(), "allowlist").plugin.manifest),
    ).toEqual([]);
  });

  it("upgrades an ABI-1 connection in place: Bot, secret, state, threads and messages stay", async () => {
    const f = await upgraded(CLAIMS());
    const row = f.ctx.db.prepare("SELECT * FROM channel_connections WHERE id = 'chn_qr'").get();
    expect(row).toMatchObject({
      api_version: 2,
      plugin_version: "2.0.0",
      bot_id: "bot_a",
      secret_id: f.secretId,
      method: "qr",
      binding_generation: 1,
      credential_generation: 1,
      multiple_connections: 0,
      // Claimed by the plugin on restore, over the migration's pending key.
      account_key: `whatsapp:linked:${LINKED}`,
    });
    expect(f.opens.map((o) => [o.connectionId, o.reason]).sort()).toEqual([
      ["chn_cl", "restore"],
      ["chn_qr", "restore"],
    ]);
    expect(f.opens.find((o) => o.connectionId === "chn_qr")?.stateDirectory).toBe(f.qrState);
    expect(statSync(f.qrState).mode & 0o777).toBe(0o700);
    expect(statSync(join(f.qrState, "session.json")).mode & 0o777).toBe(0o600);
    expect(f.ctx.db.prepare("SELECT * FROM threads WHERE id = 'thr_qr'").get()).toMatchObject({
      channel: "whatsapp",
      channel_connection_id: "chn_qr",
      binding_generation: 1,
      external_key: `chn_qr:1:web:${LINKED}:${PERSON}`,
    });
    expect(f.ctx.db.prepare("SELECT * FROM threads WHERE id = 'thr_cl'").get()).toMatchObject({
      channel_connection_id: "chn_cl",
      external_key: `chn_cl:1:1234:${CLOUD_PERSON}`,
    });
    expect(
      f.ctx.db.prepare("SELECT channel_connection_id FROM threads WHERE id = 'thr_web'").get(),
    ).toEqual({ channel_connection_id: null });
    const [listed] = await f.ctx.channels.list("ws_a" as WorkspaceId);
    expect(listed).toMatchObject({
      id: "chn_qr",
      apiVersion: 2,
      bindingGeneration: 1,
      identityKey: `whatsapp:linked:${LINKED}`,
    });
    expect(JSON.stringify(listed)).not.toContain(f.secretId);
    expect(f.opens.find((o) => o.connectionId === "chn_qr")?.secrets).toEqual({
      proxyUrl: "http://proxy.example.test:3128",
    });
  });

  it("serves a known conversation from its old thread through the ABI-2 host, both ways", async () => {
    const f = await upgraded(CLAIMS());
    const host = f.hosts.get("chn_qr") as ChannelConnectionHost;
    const conversationKey = `web:${LINKED}:${PERSON}`;
    expect((await host.findThread(conversationKey))?.id).toBe("thr_qr");
    // A redelivery of a message posted under ABI 1 is still a duplicate.
    expect(
      await host.receive({
        conversationKey,
        senderId: PERSON,
        externalId: `web:${LINKED}:m1`,
        body: "hello",
      }),
    ).toEqual({ status: "duplicate", threadId: "thr_qr", messageId: "msg_1" });
    const posted = await host.receive({
      conversationKey,
      senderId: PERSON,
      externalId: `web:${LINKED}:m2`,
      body: "again",
    });
    expect(posted).toMatchObject({
      status: "posted",
      thread: { id: "thr_qr" },
      message: { seq: 3 },
    });
    expect(await host.conversationKeyOf("thr_qr")).toBe(conversationKey);
    expect(await host.beginSend({ threadId: "thr_qr", seq: 1 })).toEqual({
      send: false,
      reason: "sender_message",
    });
    expect(await host.beginSend({ threadId: "thr_qr", seq: 2 })).toEqual({ send: true });
    await host.recordSend({ threadId: "thr_qr", seq: 2, providerMessageIds: ["out1"] });
    expect(await host.beginSend({ threadId: "thr_qr", seq: 2 })).toEqual({
      send: false,
      reason: "already_sent",
    });
    // The other workspace's connection reaches none of it.
    const other = f.hosts.get("chn_cl") as ChannelConnectionHost;
    await expect(other.listMessages("thr_qr", 0)).rejects.toMatchObject({ code: "not_found" });
  });

  it("drops the stored allowlists, blocks nobody and stamps the connections (ADR-0017 amendment 3)", async () => {
    const f = await upgraded(CLAIMS());
    const rows = f.ctx.db
      .prepare("SELECT id, config_json, admission_changed_at FROM channel_connections ORDER BY id")
      .all() as { id: string; config_json: string; admission_changed_at: string | null }[];
    expect(rows.map((row) => [row.id, JSON.parse(row.config_json)])).toEqual([
      ["chn_cl", { phoneNumberId: "1234" }],
      ["chn_qr", {}],
    ]);
    for (const row of rows) expect(row.admission_changed_at).toMatch(/^2\d{3}-\d\d-\d\dT/);
    expect(f.ctx.db.prepare("SELECT count(*) AS n FROM channel_sender_blocks").get()).toEqual({
      n: 0,
    });
    const [listed] = await f.ctx.channels.list("ws_a" as WorkspaceId);
    expect(listed?.admissionChangedAt).toBe(rows[1]?.admission_changed_at);
    expect(JSON.stringify(listed)).not.toContain(PERSON);
    // A never-listed number and a formerly listed one are both admitted now.
    const qr = f.hosts.get("chn_qr") as ChannelConnectionHost;
    expect(await qr.admits?.(STRANGER)).toBe(true);
    const stranger = await qr.receive({
      conversationKey: `web:${LINKED}:${STRANGER}`,
      senderId: STRANGER,
      externalId: "web:x:1",
      body: "hello",
    });
    expect(stranger).toMatchObject({ status: "posted", thread: { channelConnectionId: "chn_qr" } });
    const cloud = f.hosts.get("chn_cl") as ChannelConnectionHost;
    expect(
      await cloud.receive({
        conversationKey: `1234:${CLOUD_PERSON}`,
        senderId: CLOUD_PERSON,
        externalId: "wamid.after",
        body: "still here",
      }),
    ).toMatchObject({ status: "posted", thread: { id: "thr_cl" } });
    // The blocklist routes accept a WhatsApp connection now.
    expect(await f.ctx.channels.listBlocks("ws_a" as WorkspaceId, "chn_qr")).toEqual([]);
  });

  it("gives a blocked sender nothing in either direction and decides nothing for them", async () => {
    const f = await upgraded(CLAIMS());
    const host = f.hosts.get("chn_qr") as ChannelConnectionHost;
    const count = () =>
      (
        f.ctx.db
          .prepare(
            "SELECT (SELECT count(*) FROM threads) + (SELECT count(*) FROM thread_messages) AS n",
          )
          .get() as { n: number }
      ).n;
    f.ctx.channels.block("ws_a" as WorkspaceId, "chn_qr", { senderId: STRANGER }, "admin");
    const before = count();
    expect(
      await host.receive({
        conversationKey: `web:${LINKED}:${STRANGER}`,
        senderId: STRANGER,
        externalId: "web:x:1",
        body: "let me in",
      }),
    ).toEqual({ status: "blocked" });
    expect(await host.admits?.(STRANGER)).toBe(false);
    expect(await host.admits?.(PERSON)).toBe(true);
    expect(count()).toBe(before);
    // A person blocked after writing receives nothing further and decides nothing.
    expect(await host.beginSend({ threadId: "thr_qr", seq: 2 })).toEqual({ send: true });
    f.ctx.channels.block("ws_a" as WorkspaceId, "chn_qr", { senderId: PERSON }, "admin");
    expect(await host.beginSend({ threadId: "thr_qr", seq: 2 })).toEqual({
      send: false,
      reason: "blocked",
    });
    const run = f.ctx.runs.create({
      botId: "bot_a" as BotId,
      threadId: "thr_qr" as ThreadId,
      lane: "background",
      triggerKind: "webhook",
      triggerRef: "whatsapp-abi2-test",
    });
    f.ctx.approvals.create({
      id: "apr_wa" as ApprovalId,
      runId: run.id as RunId,
      botId: "bot_a" as BotId,
      threadId: "thr_qr" as ThreadId,
      action: { toolName: "Bash", input: { command: "curl https://x.test" } },
      riskLevel: "L2",
    });
    await expect(
      host.decideApproval({ id: "apr_wa", decision: "allow_once", senderId: PERSON }),
    ).rejects.toMatchObject({ code: "forbidden" });
    // Unblocking admits the person again; what was skipped is not replayed (ADR-0017 decision 4).
    f.ctx.channels.unblock("ws_a" as WorkspaceId, "chn_qr", PERSON);
    expect(await host.admits?.(PERSON)).toBe(true);
  });

  it("keeps the contract's allowlist mode for a plugin that declares it (amendment 1 A2)", async () => {
    const f = await upgraded(CLAIMS(), "allowlist");
    const host = f.hosts.get("chn_qr") as ChannelConnectionHost;
    // The migration dropped the stored list; an allowlist plugin then admits nobody until listed.
    expect(await host.admits?.(PERSON)).toBe(false);
    f.ctx.db
      .prepare("UPDATE channel_connections SET config_json = ? WHERE id = 'chn_qr'")
      .run(JSON.stringify({ allowedSenders: PERSON }));
    expect(
      await host.receive({
        conversationKey: `web:${LINKED}:${STRANGER}`,
        senderId: STRANGER,
        externalId: "web:x:1",
        body: "let me in",
      }),
    ).toEqual({ status: "blocked" });
    expect(await host.admits?.(STRANGER)).toBe(false);
    expect(await host.admits?.(PERSON)).toBe(true);
    // The blocklist of ADR-0047 decision 13 does not apply to an allowlist plugin.
    expect(() =>
      f.ctx.channels.block("ws_a" as WorkspaceId, "chn_qr", { senderId: STRANGER }, "admin"),
    ).toThrow(/allowlist/);
    // A person removed from the allowlist receives nothing further from the bound thread.
    f.ctx.db
      .prepare("UPDATE channel_connections SET config_json = ? WHERE id = 'chn_qr'")
      .run(JSON.stringify({ allowedSenders: "" }));
    expect(await host.beginSend({ threadId: "thr_qr", seq: 2 })).toEqual({
      send: false,
      reason: "blocked",
    });
  });

  it("gives a stale handle no effect after a reconnect", async () => {
    const f = await upgraded(CLAIMS());
    const stale = f.hosts.get("chn_qr") as ChannelConnectionHost;
    await f.ctx.channels.connectionCommand("ws_a" as WorkspaceId, "chn_qr", "reconnect");
    expect(f.hosts.get("chn_qr")).not.toBe(stale);
    const messages = () =>
      (f.ctx.db.prepare("SELECT count(*) AS n FROM thread_messages").get() as { n: number }).n;
    const before = messages();
    await expect(
      stale.receive({
        conversationKey: `web:${LINKED}:${PERSON}`,
        senderId: PERSON,
        externalId: "web:late:1",
        body: "late",
      }),
    ).rejects.toMatchObject({ code: "channel_connection_stale" });
    await expect(stale.beginSend({ threadId: "thr_qr", seq: 2 })).rejects.toMatchObject({
      code: "channel_connection_stale",
    });
    await expect(
      stale.claimIdentity?.({ identityKey: "whatsapp:linked:1", label: "x" }),
    ).rejects.toMatchObject({ code: "channel_connection_stale" });
    expect(messages()).toBe(before);
  });

  it("relinks a QR connection without verify, keeping its identity, Bot and proxy secret", async () => {
    const f = await upgraded(CLAIMS());
    await f.ctx.channels.connectionCommand("ws_a" as WorkspaceId, "chn_qr", "relink");
    const reopened = f.opens.at(-1);
    expect(reopened).toMatchObject({
      connectionId: "chn_qr",
      reason: "relink",
      bindingGeneration: 1,
      credentialGeneration: 2,
      identityKey: `whatsapp:linked:${LINKED}`,
      botId: "bot_a",
      secrets: { proxyUrl: "http://proxy.example.test:3128" },
    });
    // The new link must be the same number (ADR-0047 decision 8).
    const host = f.hosts.get("chn_qr") as ChannelConnectionHost;
    await expect(
      host.claimIdentity?.({ identityKey: "whatsapp:linked:15550006666", label: "x" }),
    ).rejects.toMatchObject({ code: "channel_identity_mismatch" });
  });

  it("refuses a second connection in the workspace and a second claim of one number", async () => {
    const f = await upgraded(CLAIMS());
    await expect(
      f.ctx.channels.connect("ws_a" as WorkspaceId, "whatsapp", {
        method: "cloud",
        botId: "bot_a",
        config: { phoneNumberId: "777" },
      }),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    // The Cloud API number already serving ws_b cannot be connected again elsewhere.
    await expect(
      f.ctx.channels.connect("ws_c" as WorkspaceId, "whatsapp", {
        method: "cloud",
        botId: "bot_c",
        config: { phoneNumberId: "1234" },
      }),
    ).rejects.toMatchObject({ code: "channel_identity_in_use" });
    // A QR connect stores a pending key; linking the number ws_a holds is refused at the claim.
    const [pendingFirst] = [
      await f.ctx.channels.connect("ws_c" as WorkspaceId, "whatsapp", {
        method: "qr",
        botId: "bot_c",
        config: {},
      }),
    ];
    expect(pendingFirst?.identityKey).toBeUndefined();
    // A connection made after the admission change has nothing to be told about it.
    expect(pendingFirst?.admissionChangedAt).toBeUndefined();
    const host = f.hosts.get(pendingFirst?.id as string) as ChannelConnectionHost;
    await expect(
      host.claimIdentity?.({ identityKey: `whatsapp:linked:${LINKED}`, label: "x" }),
    ).rejects.toMatchObject({ code: "channel_identity_in_use" });
    await host.claimIdentity?.({
      identityKey: "whatsapp:linked:15550004444",
      label: "+15550004444",
    });
    await expect(
      host.claimIdentity?.({ identityKey: "whatsapp:linked:15550005555", label: "x" }),
    ).rejects.toMatchObject({ code: "channel_identity_mismatch" });
    const [listed] = await f.ctx.channels.list("ws_c" as WorkspaceId);
    expect(listed?.identityKey).toBe("whatsapp:linked:15550004444");
  });

  it("refuses the restore claim of a number two ABI-1 workspaces had both linked", async () => {
    const claims = CLAIMS();
    claims.set("chn_cl", `whatsapp:linked:${LINKED}`);
    const f = await upgraded(claims);
    // Whichever restores second is refused and keeps its pending key; nothing is re-linked.
    expect(f.refusals).toHaveLength(1);
    const refused = f.refusals[0]?.connectionId as string;
    expect(f.refusals[0]?.code).toBe("channel_identity_in_use");
    expect(
      f.ctx.db.prepare("SELECT account_key FROM channel_connections WHERE id = ?").get(refused),
    ).toEqual({ account_key: `whatsapp:pending:${refused}` });
  });

  it("stops a linked QR connection in Trash, keeps its link across a restart and resumes it on restore (ADR-0017 amendment 1 P6)", async () => {
    const f = await upgraded(CLAIMS());
    const host = f.hosts.get("chn_qr") as ChannelConnectionHost;
    await new TrashLifecycle(f.ctx, (harness as Harness).app.deskmates.scheduler).archiveWorkspace(
      "ws_a" as WorkspaceId,
      "usr_test",
    );
    // Closed with `archive`, not `disconnect`: the plugin keeps the link (no logout).
    expect(f.closes).toEqual([{ connectionId: "chn_qr", reason: "archive" }]);
    expect(f.hosts.has("chn_cl")).toBe(true);
    expect(statSync(join(f.qrState, "session.json")).mode & 0o777).toBe(0o600);
    expect(
      f.ctx.db.prepare("SELECT count(*) AS n FROM secrets WHERE id = ?").get(f.secretId),
    ).toEqual({ n: 1 });
    await expect(
      host.receive({
        conversationKey: `web:${LINKED}:${PERSON}`,
        senderId: PERSON,
        externalId: `web:${LINKED}:m-archived`,
        body: "anyone?",
      }),
    ).rejects.toMatchObject({ code: "channel_connection_stale" });

    // A Gateway restart while the workspace is in Trash does not open the connection.
    await harness?.close();
    const after = whatsappShaped(CLAIMS());
    harness = await startHarness(
      { dbPath: f.dbPath, channelStateDir: f.stateRoot, secretsKey: CHANNEL_SECRETS_KEY },
      undefined,
      { channelPlugins: new Map([["whatsapp", after.plugin]]) },
    );
    harness.provider.onRun(() => new Promise(() => {}));
    const ctx = harness.app.deskmates.ctx;
    expect(after.opens.map((o) => o.connectionId)).toEqual(["chn_cl"]);
    const [stopped] = await ctx.channels.list("ws_a" as WorkspaceId);
    expect(stopped?.status.phase).toBe(CHANNEL_PHASE_ARCHIVED);

    // Restore opens it with the same generations, secret and state: nothing is re-linked.
    const trash = new TrashLifecycle(ctx, harness.app.deskmates.scheduler);
    await trash.restoreWorkspace("ws_a" as WorkspaceId, "usr_test");
    const reopened = after.opens.find((o) => o.connectionId === "chn_qr");
    expect(reopened).toMatchObject({
      reason: "restore",
      identityKey: `whatsapp:linked:${LINKED}`,
      bindingGeneration: 1,
      credentialGeneration: 1,
      stateDirectory: f.qrState,
      secrets: { proxyUrl: "http://proxy.example.test:3128" },
    });
    const resumed = after.hosts.get("chn_qr") as ChannelConnectionHost;
    expect((await resumed.findThread(`web:${LINKED}:${PERSON}`))?.id).toBe("thr_qr");
    expect(after.refusals).toEqual([]);

    // A purge after another archive removes the kept link state; ws_b keeps its connection.
    await trash.archiveWorkspace("ws_a" as WorkspaceId, "usr_test");
    const tenantId = ctx.ownership.tenantOf("workspace", "ws_a") as string;
    await trash.deleteWorkspace("ws_a" as WorkspaceId, "ws_a", "usr_test", tenantId);
    expect(after.closes).toEqual([
      { connectionId: "chn_qr", reason: "archive" },
      { connectionId: "chn_qr", reason: "disconnect" },
    ]);
    expect(() => statSync(f.qrState)).toThrow();
    expect(
      ctx.db.prepare("SELECT count(*) AS n FROM secrets WHERE id = ?").get(f.secretId),
    ).toEqual({ n: 0 });
    expect(after.hosts.has("chn_cl")).toBe(true);
  });
});
