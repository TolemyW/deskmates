// T1, ADR-0017 amendment 1 P6 and ADR-0026 decisions 2 and 3: moving a workspace to Trash stops
// every channel connection of it (host stale, provider session closed with `archive`) and keeps
// its private state and secrets; nothing is admitted or sent while it is in Trash; restoring the
// workspace opens each connection again with the same binding and credential generation; a purge
// after the archive removes what the archive kept. Driven through the API with the fake ABI-2
// provider from @deskmates/testkit. The WhatsApp-shaped half is `whatsapp-abi2.test.ts`.

import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  CHANNEL_PHASE_ARCHIVED,
  type ChannelConnection,
  type ThreadId,
} from "@deskmates/contracts";
import { FakeChannelProvider } from "@deskmates/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { type ChannelFixture, startChannelFixture } from "../test-support/channel-connections.js";

const TOKEN_A = "fake-token-a-never-public-0101";
const TOKEN_C = "fake-token-c-never-public-0103";

let fx: ChannelFixture | undefined;
afterEach(async () => {
  await fx?.close();
  fx = undefined;
});

function provider() {
  const fake = new FakeChannelProvider();
  fake.addAccount(TOKEN_A, { accountId: "3001", label: "Alice's bot" });
  fake.addAccount(TOKEN_C, { accountId: "3003", label: "Carol's bot" });
  return fake;
}

function count(f: ChannelFixture, sql: string, ...params: unknown[]): number {
  return (f.ctx.db.prepare(sql).get(...params) as { n: number }).n;
}

async function connected(f: ChannelFixture, fake: FakeChannelProvider) {
  const a = await f.connect({ pluginId: "fakechat", token: TOKEN_A, botId: f.alice.id });
  const c = await f.connect({
    pluginId: "fakechat",
    token: TOKEN_C,
    botId: f.other.carol.id,
    workspaceId: f.other.workspace.id,
  });
  expect([a.status, c.status]).toEqual([201, 201]);
  const id = a.json.connection.id;
  const posted = await fake.deliver(id, { senderId: "u1", externalId: "m1", body: "hello" });
  if (posted.status !== "posted") throw new Error("not posted");
  return { id, other: c.json.connection.id, thread: posted.thread.id };
}

async function listed(f: ChannelFixture, workspaceId = f.workspace.id) {
  const response = await f.harness.api<{ connections: ChannelConnection[] }>(
    "GET",
    `/api/workspaces/${workspaceId}/channels`,
  );
  expect(response.status).toBe(200);
  return response.json.connections;
}

describe(
  "moving a workspace to Trash stops its channel connections (ADR-0017 amendment 1 P6)",
  { timeout: 30_000 },
  () => {
    it("stops every connection of the workspace, keeps its state and secrets, and leaves other workspaces running", async () => {
      const fake = provider();
      fx = await startChannelFixture([fake]);
      const { id, other } = await connected(fx, fake);
      const host = fake.host(id);
      const directory = join(fx.stateRoot, fx.workspace.id, "fakechat", id);
      const secrets = count(fx, "SELECT count(*) AS n FROM secrets");
      const before = fx.ctx.db
        .prepare(
          "SELECT bot_id, binding_generation, credential_generation, secret_id, account_key FROM channel_connections WHERE id = ?",
        )
        .get(id);

      const archived = await fx.harness.api("POST", `/api/workspaces/${fx.workspace.id}/archive`);
      expect(archived.status).toBe(200);

      expect(fake.closes).toEqual([{ connectionId: id, reason: "archive" }]);
      expect(fake.isOpen(id)).toBe(false);
      expect(fake.isOpen(other)).toBe(true);
      // The private state, the secret record and the binding stay for a restore.
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect(count(fx, "SELECT count(*) AS n FROM secrets")).toBe(secrets);
      expect(
        fx.ctx.db
          .prepare(
            "SELECT bot_id, binding_generation, credential_generation, secret_id, account_key FROM channel_connections WHERE id = ?",
          )
          .get(id),
      ).toEqual(before);
      // The Integrations card reads the stopped state; the other workspace's stays connected.
      expect((await listed(fx)).map((c) => [c.id, c.status.phase])).toEqual([
        [id, CHANNEL_PHASE_ARCHIVED],
      ]);
      expect((await listed(fx, fx.other.workspace.id)).map((c) => c.status.phase)).toEqual([
        "connected",
      ]);

      // Nothing is admitted while archived: the old host is stale, a webhook is refused.
      const messages = count(fx, "SELECT count(*) AS n FROM thread_messages");
      await expect(
        fake.deliver(id, { senderId: "u1", externalId: "m2", body: "still there?" }, host),
      ).rejects.toMatchObject({ code: "channel_connection_stale" });
      const hook = await fx.ctx.channels.webhook(
        fx.workspace.id,
        "fakechat",
        { method: "POST", url: "/", headers: {}, body: new Uint8Array() },
        id,
      );
      expect(hook.status).toBe(503);
      expect(fake.webhooks).toEqual([]);
      expect(count(fx, "SELECT count(*) AS n FROM thread_messages")).toBe(messages);

      // A trashed workspace is read-only: no lifecycle command reopens the connection.
      for (const command of ["reconnect", "relink", "test", "disconnect"]) {
        const refused = await fx.command(id, command);
        expect(refused.status, command).toBe(409);
        expect(refused.json.code).toBe("invalid_transition");
      }
      const rebind = await fx.rebind(id, fx.bob.id);
      expect(rebind.status).toBe(409);
      expect(fake.opens.filter((open) => open.connectionId === id)).toHaveLength(1);

      // Archiving again is a no-op for the provider.
      await fx.ctx.channels.archiveWorkspace(fx.workspace.id);
      expect(fake.closes.filter((close) => close.reason !== "archive")).toEqual([]);
    });

    it("admits no inbound between marking the workspace archived and stopping its connections", async () => {
      const fake = provider();
      fx = await startChannelFixture([fake]);
      const { id } = await connected(fx, fake);
      // The first step of the archive, alone: the row is in Trash, the provider still open.
      fx.ctx.workspaces.archive(fx.workspace.id, "usr_test");
      const messages = count(fx, "SELECT count(*) AS n FROM thread_messages");
      await expect(
        fake.deliver(id, { senderId: "u2", externalId: "m9", body: "new conversation" }),
      ).rejects.toMatchObject({
        code: "channel_connection_stale",
        details: { reason: "workspace_archived" },
      });
      await expect(fake.host(id).beginSend({ threadId: "thr_none", seq: 1 })).rejects.toMatchObject(
        { code: "channel_connection_stale" },
      );
      expect(count(fx, "SELECT count(*) AS n FROM thread_messages")).toBe(messages);
    });

    it("resumes each connection on restore with the same generations, and does not deliver what the archive left unsent", async () => {
      const fake = provider();
      fx = await startChannelFixture([fake]);
      const { id, thread } = await connected(fx, fake);
      const opened = fake.request(id);
      // A reply written just before the archive, which the provider has not relayed yet.
      let release: () => void = () => {};
      fake.hold = new Promise<void>((done) => {
        release = done;
      });
      fx.reply(thread, fx.alice.id, "late reply");
      expect(
        (await fx.harness.api("POST", `/api/workspaces/${fx.workspace.id}/archive`)).status,
      ).toBe(200);
      release();
      fake.hold = undefined;
      await fake.settle();
      expect(fake.deliveries).toEqual([]);

      const restored = await fx.harness.api("POST", `/api/workspaces/${fx.workspace.id}/restore`);
      expect(restored.status).toBe(200);
      expect(fake.opens.filter((open) => open.connectionId === id).map((o) => o.reason)).toEqual([
        "connect",
        "restore",
      ]);
      // No relink: the same identity, Bot, generations, secrets and state directory.
      expect(fake.request(id)).toMatchObject({
        reason: "restore",
        identityKey: opened.identityKey,
        botId: fx.alice.id,
        bindingGeneration: 1,
        credentialGeneration: 1,
        secrets: { token: TOKEN_A },
        stateDirectory: opened.stateDirectory,
      });
      expect((await listed(fx)).map((c) => c.status.phase)).toEqual(["connected"]);

      // The known conversation lands in its old thread and the new reply goes out; the reply
      // the archive left unsent stays cancelled.
      const again = await fake.deliver(id, { senderId: "u1", externalId: "m3", body: "back?" });
      if (again.status !== "posted") throw new Error("not posted");
      expect(again.thread.id).toBe(thread);
      fx.reply(thread, fx.alice.id, "yes, back");
      await fake.settle();
      expect(fake.deliveries.map((d) => d.body)).toEqual(["yes, back"]);
      expect(fake.skipped.map((s) => [s.threadId, s.permit.reason])).toContainEqual([
        thread,
        "cancelled",
      ]);
      const receipt = fx.ctx.db
        .prepare(
          `SELECT r.state, r.reason FROM channel_outbound_receipts r JOIN thread_messages m
             ON m.thread_id = r.thread_id AND m.seq = r.message_seq WHERE m.body = 'late reply'`,
        )
        .get();
      expect(receipt).toEqual({ state: "cancelled", reason: "workspace_archived" });
      expect(fx.ctx.threads.get(thread as ThreadId)?.bindingGeneration).toBe(1);
    });

    it("removes what the archive kept when the workspace is then deleted permanently", async () => {
      const fake = provider();
      fx = await startChannelFixture([fake]);
      const { id, other } = await connected(fx, fake);
      const directory = join(fx.stateRoot, fx.workspace.id, "fakechat", id);
      await fx.harness.api("POST", `/api/workspaces/${fx.workspace.id}/archive`);
      expect((await stat(directory)).isDirectory()).toBe(true);

      const purged = await fx.harness.api("DELETE", `/api/workspaces/${fx.workspace.id}`, {
        name: fx.workspace.name,
      });
      expect(purged.status).toBeLessThan(300);
      expect(fake.closes).toEqual([
        { connectionId: id, reason: "archive" },
        { connectionId: id, reason: "disconnect" },
      ]);
      await expect(stat(join(fx.stateRoot, fx.workspace.id))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(
        count(
          fx,
          "SELECT count(*) AS n FROM channel_connections WHERE workspace_id = ?",
          fx.workspace.id,
        ),
      ).toBe(0);
      expect(
        count(
          fx,
          "SELECT count(*) AS n FROM secrets WHERE owner_kind = 'workspace' AND owner_id = ?",
          fx.workspace.id,
        ),
      ).toBe(0);
      // The other workspace's connection is untouched.
      expect(fake.isOpen(other)).toBe(true);
    });
  },
);
