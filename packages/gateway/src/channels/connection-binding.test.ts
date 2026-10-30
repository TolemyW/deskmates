// T1, ADR-0047 decisions 3 to 7, 14 and 15: an ABI-2 connection is one verified external identity
// bound to one Bot, unique across the installation; a plugin may hold several connections in one
// workspace; its runtime loads only when a connection of it is used; its private state goes on
// disconnect and on workspace purge. Driven through the API with
// the fake ABI-2 provider from @deskmates/testkit.

import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { BotId, RunId, ThreadId } from "@deskmates/contracts";
import { FakeChannelProvider } from "@deskmates/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { type ChannelFixture, startChannelFixture } from "../test-support/channel-connections.js";
import { TrashLifecycle } from "../workspaces/trash-lifecycle.js";

const TOKEN_A = "fake-token-a-never-public-0001";
const TOKEN_A_ROTATED = "fake-token-a-rotated-never-public-0002";
const TOKEN_B = "fake-token-b-never-public-0003";

let fx: ChannelFixture | undefined;
afterEach(async () => {
  await fx?.close();
  fx = undefined;
});

function provider(options: ConstructorParameters<typeof FakeChannelProvider>[0] = {}) {
  const fake = new FakeChannelProvider(options);
  fake.addAccount(TOKEN_A, { accountId: "1001", label: "Alice's bot" });
  fake.addAccount(TOKEN_A_ROTATED, { accountId: "1001", label: "Alice's bot" });
  fake.addAccount(TOKEN_B, { accountId: "2002", label: "Bob's bot" });
  return fake;
}

function count(f: ChannelFixture, sql: string, ...params: unknown[]): number {
  return (f.ctx.db.prepare(sql).get(...params) as { n: number }).n;
}

describe(
  "ABI-2 connections bind one verified identity to one Bot (ADR-0047)",
  { timeout: 30_000 },
  () => {
    it("creates a plugin's runtime only when one of its connections is used (decision 15)", async () => {
      const used = provider();
      const unused = provider({ id: "otherchat" });
      fx = await startChannelFixture([used, unused]);
      const catalog = await fx.harness.api<{ plugins: { manifest: { id: string } }[] }>(
        "GET",
        "/api/channels",
      );
      expect(catalog.json.plugins.map((p) => p.manifest.id).sort()).toEqual([
        "fakechat",
        "otherchat",
      ]);
      expect(used.created).toBe(0);
      expect(fx.ctx.channels.runtimeLoaded("fakechat")).toBe(false);
      const connected = await fx.connect({
        pluginId: "fakechat",
        token: TOKEN_A,
        botId: fx.alice.id,
      });
      expect(connected.status).toBe(201);
      expect(used.created).toBe(1);
      expect(unused.created).toBe(0);
      expect(fx.ctx.channels.runtimeLoaded("otherchat")).toBe(false);
    });

    it("keeps two connections of one plugin, bound to two Bots, apart in threads and runs (decisions 3 to 5, V2)", async () => {
      const fake = provider();
      fx = await startChannelFixture([fake]);
      const a = await fx.connect({ pluginId: "fakechat", token: TOKEN_A, botId: fx.alice.id });
      const b = await fx.connect({ pluginId: "fakechat", token: TOKEN_B, botId: fx.bob.id });
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(a.json.connection).toMatchObject({
        apiVersion: 2,
        identityKey: "fakechat:bot:1001",
        identityLabel: "Alice's bot",
        bindingGeneration: 1,
        botId: fx.alice.id,
      });
      expect(b.json.connection.identityKey).toBe("fakechat:bot:2002");

      // The same person and the same provider message id reach both bots.
      const viaA = await fake.deliver(a.json.connection.id, {
        senderId: "u1",
        externalId: "m1",
        body: "hello @bob",
      });
      const viaB = await fake.deliver(b.json.connection.id, {
        senderId: "u1",
        externalId: "m1",
        body: "hello",
      });
      if (viaA.status !== "posted" || viaB.status !== "posted") throw new Error("not posted");
      expect(viaA.thread.id).not.toBe(viaB.thread.id);
      // An @name in the person's text never adds a member: only the bound Bot is woken.
      expect(fx.ctx.threads.members(viaA.thread.id).map((m) => m.botId)).toEqual([fx.alice.id]);
      expect(fx.ctx.threads.members(viaB.thread.id).map((m) => m.botId)).toEqual([fx.bob.id]);
      expect(viaA.runs.map((run) => run.botId)).toEqual([fx.alice.id]);
      expect(viaB.runs.map((run) => run.botId)).toEqual([fx.bob.id]);
      expect(viaA.thread).toMatchObject({
        channel: "fakechat",
        channelConnectionId: a.json.connection.id,
        bindingGeneration: 1,
      });

      // A reply is relayed only by the connection whose thread it is in.
      fx.reply(viaA.thread.id, fx.alice.id, "hi from alice");
      await fake.settle();
      expect(fake.deliveries.map((d) => [d.connectionId, d.conversationKey, d.body])).toEqual([
        [a.json.connection.id, "u1", "hi from alice"],
      ]);

      // Each run records its own connection, so usage aggregates by connection.
      const byConnection = new Map<string, RunId[]>();
      for (const run of fx.ctx.runs.list({})) {
        const stamp = run.config.channelConnection as { id: string } | undefined;
        if (stamp) byConnection.set(stamp.id, [...(byConnection.get(stamp.id) ?? []), run.id]);
      }
      expect(byConnection.get(a.json.connection.id)).toEqual([viaA.runs[0]?.id]);
      expect(byConnection.get(b.json.connection.id)).toEqual([viaB.runs[0]?.id]);
    });

    it("lets one Bot hold connections of two plugins without sharing a thread", async () => {
      const first = provider();
      const second = provider({ id: "otherchat" });
      fx = await startChannelFixture([first, second]);
      const a = await fx.connect({ pluginId: "fakechat", token: TOKEN_A, botId: fx.alice.id });
      const b = await fx.connect({ pluginId: "otherchat", token: TOKEN_A, botId: fx.alice.id });
      expect([a.status, b.status]).toEqual([201, 201]);
      const one = await first.deliver(a.json.connection.id, {
        senderId: "u1",
        externalId: "x",
        body: "a",
      });
      const two = await second.deliver(b.json.connection.id, {
        senderId: "u1",
        externalId: "x",
        body: "b",
      });
      if (one.status !== "posted" || two.status !== "posted") throw new Error("not posted");
      expect(one.thread.id).not.toBe(two.thread.id);
      expect([one.thread.channel, two.thread.channel]).toEqual(["fakechat", "otherchat"]);
    });

    it("refuses a second connection of the same identity in any workspace, before storing anything (decision 7)", async () => {
      const fake = provider();
      fx = await startChannelFixture([fake]);
      const first = await fx.connect({ pluginId: "fakechat", token: TOKEN_A, botId: fx.alice.id });
      expect(first.status).toBe(201);
      const secrets = count(fx, "SELECT count(*) AS n FROM secrets");
      // The same token, a second token for the same bot, and the same bot in another workspace.
      for (const attempt of [
        { token: TOKEN_A, botId: fx.bob.id },
        { token: TOKEN_A_ROTATED, botId: fx.bob.id },
        { token: TOKEN_A, botId: fx.other.carol.id, workspaceId: fx.other.workspace.id },
      ]) {
        const refused = await fx.connect({ pluginId: "fakechat", ...attempt });
        expect(refused.status, attempt.token).toBe(409);
        expect(refused.json.code).toBe("channel_identity_in_use");
      }
      expect(count(fx, "SELECT count(*) AS n FROM channel_connections")).toBe(1);
      expect(count(fx, "SELECT count(*) AS n FROM secrets")).toBe(secrets);
      // A credential the provider refuses stores nothing either.
      const unknown = await fx.connect({ pluginId: "fakechat", token: "nobody", botId: fx.bob.id });
      expect(unknown.status).toBe(400);
      expect(count(fx, "SELECT count(*) AS n FROM channel_connections")).toBe(1);
    });

    it("relinks the same identity in place and refuses another identity (decision 8)", async () => {
      const fake = provider();
      fx = await startChannelFixture([fake]);
      const a = await fx.connect({ pluginId: "fakechat", token: TOKEN_A, botId: fx.alice.id });
      const id = a.json.connection.id;
      const before = fake.host(id);
      const mismatch = await fx.command(id, "relink", { config: { token: TOKEN_B } });
      expect(mismatch.status).toBe(409);
      expect(mismatch.json.code).toBe("channel_identity_mismatch");
      expect(fake.request(id).credentialGeneration).toBe(1);

      const relinked = await fx.command(id, "relink", { config: { token: TOKEN_A_ROTATED } });
      expect(relinked.status).toBe(200);
      expect(relinked.json.connection).toMatchObject({ bindingGeneration: 1, botId: fx.alice.id });
      expect(fake.request(id)).toMatchObject({
        reason: "relink",
        bindingGeneration: 1,
        credentialGeneration: 2,
        secrets: { token: TOKEN_A_ROTATED },
      });
      expect(fake.closes.at(-1)).toEqual({ connectionId: id, reason: "relink" });
      await expect(
        fake.deliver(id, { senderId: "u1", externalId: "m", body: "x" }, before),
      ).rejects.toMatchObject({ code: "channel_connection_stale" });
      expect(count(fx, "SELECT count(*) AS n FROM secrets")).toBe(1);
    });

    it("keeps one connection per workspace for a plugin without multipleConnections", async () => {
      const single = provider({ multipleConnections: false });
      fx = await startChannelFixture([single]);
      expect(
        (await fx.connect({ pluginId: "fakechat", token: TOKEN_A, botId: fx.alice.id })).status,
      ).toBe(201);
      const second = await fx.connect({ pluginId: "fakechat", token: TOKEN_B, botId: fx.bob.id });
      expect(second.status).toBe(409);
      expect(second.json.code).toBe("invalid_transition");
    });

    it("never shows a credential and removes the connection's private state on disconnect (decision 14)", async () => {
      const fake = provider();
      fx = await startChannelFixture([fake]);
      const a = await fx.connect({ pluginId: "fakechat", token: TOKEN_A, botId: fx.alice.id });
      const id = a.json.connection.id;
      const listed = await fx.harness.api<unknown>(
        "GET",
        `/api/workspaces/${fx.workspace.id}/channels`,
      );
      expect(JSON.stringify([a.json, listed.json])).not.toContain(TOKEN_A);
      const row = fx.ctx.db
        .prepare("SELECT config_json, account_key FROM channel_connections WHERE id = ?")
        .get(id) as { config_json: string; account_key: string };
      expect(row).toEqual({ config_json: "{}", account_key: "fakechat:bot:1001" });
      const directory = join(fx.stateRoot, fx.workspace.id, "fakechat", id);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      const posted = await fake.deliver(id, { senderId: "u1", externalId: "m1", body: "hi" });
      if (posted.status !== "posted") throw new Error("not posted");

      const gone = await fx.command(id, "disconnect");
      expect(gone.status).toBe(200);
      expect(gone.json.connection).toBeNull();
      expect(fake.closes.at(-1)).toEqual({ connectionId: id, reason: "disconnect" });
      await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
      expect(count(fx, "SELECT count(*) AS n FROM secrets")).toBe(0);
      // The conversation stays as a read-only mirror; the identity may be connected again.
      expect(fx.ctx.threads.get(posted.thread.id as ThreadId)?.channel).toBe("fakechat");
      const again = await fx.connect({
        pluginId: "fakechat",
        token: TOKEN_A,
        botId: fx.bob.id as BotId,
      });
      expect(again.status).toBe(201);
    });

    it("closes a purged workspace's connections and removes their private state (decision 14)", async () => {
      const fake = provider();
      fx = await startChannelFixture([fake]);
      const id = (await fx.connect({ pluginId: "fakechat", token: TOKEN_A, botId: fx.alice.id }))
        .json.connection.id;
      const directory = join(fx.stateRoot, fx.workspace.id, "fakechat", id);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      const host = fake.host(id);

      const trash = new TrashLifecycle(fx.ctx, fx.harness.app.deskmates.scheduler);
      await trash.archiveWorkspace(fx.workspace.id, "usr_test");
      await trash.deleteWorkspace(fx.workspace.id, fx.workspace.name, "usr_test", "tnt_default");

      expect(fake.closes.at(-1)).toEqual({ connectionId: id, reason: "disconnect" });
      await expect(stat(join(fx.stateRoot, fx.workspace.id))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(count(fx, "SELECT count(*) AS n FROM channel_connections")).toBe(0);
      // The purged connection's host has no effect any more.
      await expect(
        host.receive({ conversationKey: "c1", senderId: "u1", externalId: "late", body: "hi" }),
      ).rejects.toMatchObject({ code: "channel_connection_stale" });
    });
  },
);
