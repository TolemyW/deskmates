// T1, ADR-0047 decision 13: an ABI-2 connection admits every sender unless the sender is on the
// connection's blocklist. A blocked sender is dropped in both directions; unblocking replays
// nothing; only Owners and Admins manage the list; an ABI-1 connection keeps its own allowlist.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalId, ChannelPlugin, RunId, ThreadId } from "@deskmates/contracts";
import { FakeChannelProvider } from "@deskmates/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { FAST_AUTH } from "../test-support/browser-session.js";
import {
  CHANNEL_SECRETS_KEY,
  type ChannelFixture,
  startChannelFixture,
} from "../test-support/channel-connections.js";
import { type Harness, startHarness } from "../test-support/harness.js";
import { seedRoles } from "../test-support/roles.js";

let fx: ChannelFixture | undefined;
let roles: Harness | undefined;
let rolesState: string | undefined;
afterEach(async () => {
  await fx?.close();
  fx = undefined;
  await roles?.close();
  roles = undefined;
  if (rolesState) await rm(rolesState, { recursive: true, force: true });
  rolesState = undefined;
});

function provider() {
  const fake = new FakeChannelProvider();
  fake.addAccount("tok-a", { accountId: "1", label: "A" });
  return fake;
}

describe(
  "allow by default with a per-connection blocklist (ADR-0047 decision 13)",
  { timeout: 30_000 },
  () => {
    it("admits any sender, drops a blocked one both ways and does not replay after unblocking", async () => {
      const fake = provider();
      fx = await startChannelFixture([fake]);
      const f = fx;
      const id = (await f.connect({ pluginId: "fakechat", token: "tok-a", botId: f.alice.id })).json
        .connection.id;
      const blocks = `/api/workspaces/${f.workspace.id}/channel-connections/${id}/blocks`;
      // Nobody was listed anywhere, and a stranger is admitted.
      const admitted = await fake.deliver(id, {
        senderId: "stranger",
        externalId: "s1",
        body: "hi",
      });
      expect(admitted.status).toBe("posted");
      const known = await fake.deliver(id, { senderId: "u1", externalId: "k1", body: "hello" });
      if (known.status !== "posted") throw new Error("not posted");

      const added = await f.harness.api<{ block: { senderId: string; note?: string } }>(
        "POST",
        blocks,
        { senderId: " u1 ", note: "spam" },
      );
      expect(added.status).toBe(201);
      expect(added.json.block).toMatchObject({ senderId: "u1", note: "spam" });
      expect((await f.harness.api("POST", blocks, { senderId: "u1" })).status).toBe(200);
      const listed = await f.harness.api<{ blocks: { senderId: string }[] }>("GET", blocks);
      expect(listed.json.blocks.map((b) => b.senderId)).toEqual(["u1"]);

      // Inbound: dropped with no thread, message or run.
      const count = (sql: string) => (f.ctx.db.prepare(sql).get() as { n: number }).n;
      const before = {
        threads: count("SELECT count(*) AS n FROM threads"),
        messages: count("SELECT count(*) AS n FROM thread_messages"),
        runs: count("SELECT count(*) AS n FROM runs"),
      };
      expect(await fake.deliver(id, { senderId: "u1", externalId: "k2", body: "more" })).toEqual({
        status: "blocked",
      });
      expect(
        await fake.deliver(id, {
          senderId: "u1",
          conversationKey: "new-chat",
          externalId: "k3",
          body: "x",
        }),
      ).toEqual({
        status: "blocked",
      });
      expect({
        threads: count("SELECT count(*) AS n FROM threads"),
        messages: count("SELECT count(*) AS n FROM thread_messages"),
        runs: count("SELECT count(*) AS n FROM runs"),
      }).toEqual(before);

      // Outbound: the thread keeps its history, but nothing more is sent to the person.
      f.reply(known.thread.id, f.alice.id, "while blocked");
      await fake.settle();
      expect(fake.deliveries).toEqual([]);
      expect(fake.skipped.map((s) => s.permit)).toEqual([{ send: false, reason: "blocked" }]);

      // A blocked person cannot decide an approval in their thread either.
      const run = f.ctx.runs.create({
        botId: f.alice.id,
        threadId: known.thread.id as ThreadId,
        lane: "background",
        triggerKind: "webhook",
        triggerRef: "blocklist-test",
      });
      f.ctx.approvals.create({
        id: "apr_blocked" as ApprovalId,
        runId: run.id as RunId,
        botId: f.alice.id,
        threadId: known.thread.id as ThreadId,
        action: { toolName: "Bash", input: { command: "curl https://x.test" } },
        riskLevel: "L2",
      });
      await expect(
        fake.host(id).decideApproval({ id: "apr_blocked", decision: "allow_once", senderId: "u1" }),
      ).rejects.toMatchObject({ code: "forbidden" });

      const removed = await f.harness.api<{ removed: boolean }>("DELETE", `${blocks}/u1`);
      expect(removed.json.removed).toBe(true);
      f.reply(known.thread.id, f.alice.id, "after unblocking");
      await fake.settle();
      expect(fake.deliveries.map((d) => d.body)).toEqual(["after unblocking"]);
      expect(
        (await fake.deliver(id, { senderId: "u1", externalId: "k4", body: "back" })).status,
      ).toBe("posted");
      const actions = f.ctx.db
        .prepare(
          "SELECT action FROM audit_events WHERE action LIKE 'channel.sender_%' ORDER BY seq",
        )
        .all();
      expect(actions).toEqual([
        { action: "channel.sender_block" },
        { action: "channel.sender_unblock" },
      ]);
    });

    it("lets only Owners and Admins read and change the blocklist", async () => {
      const fake = provider();
      rolesState = await mkdtemp(join(tmpdir(), "deskmates-blocklist-roles-"));
      roles = await startHarness(
        { auth: FAST_AUTH, secretsKey: CHANNEL_SECRETS_KEY, channelStateDir: rolesState },
        undefined,
        { channelPlugins: new Map([["fakechat", fake.plugin]]) },
      );
      const people = await seedRoles(roles);
      const connected = await roles.api<{ connection: { id: string } }>(
        "POST",
        `/api/workspaces/${people.workspace.id}/channels/fakechat/connect`,
        { method: "token", botId: people.bot.id, config: { token: "tok-a" } },
      );
      expect(connected.status).toBe(201);
      const blocks = `/api/workspaces/${people.workspace.id}/channel-connections/${connected.json.connection.id}/blocks`;
      for (const jar of [people.member, people.guest]) {
        expect((await jar.fetch("GET", blocks)).status).toBe(403);
        expect((await jar.fetch("POST", blocks, { body: { senderId: "u1" } })).status).toBe(403);
      }
      expect((await people.admin.fetch("POST", blocks, { body: { senderId: "u1" } })).status).toBe(
        201,
      );
      expect((await people.owner.fetch("GET", blocks)).status).toBe(200);
      expect((await people.member.fetch("DELETE", `${blocks}/u1`)).status).toBe(403);
      expect((await people.owner.fetch("DELETE", `${blocks}/u1`)).status).toBe(200);
      await roles.api(
        "POST",
        `/api/workspaces/${people.workspace.id}/channel-connections/${connected.json.connection.id}/commands/disconnect`,
        {},
      );
    });

    it("keeps an ABI-1 connection on its own allowlist", async () => {
      const legacy: ChannelPlugin = {
        manifest: {
          apiVersion: 1,
          id: "legacy",
          version: "1.0.0",
          displayName: "Legacy",
          description: "ABI 1",
          capabilities: { directMessages: true, groups: false, testMessage: false },
          methods: [{ id: "plain", label: "Plain", description: "Plain", fields: [] }],
          statusVocabulary: ["connected"],
        },
        create: async () => ({
          connect: async () => ({ phase: "connected" }),
          restore: async () => ({ phase: "connected" }),
          status: async () => ({ phase: "connected" }),
          command: async () => ({ phase: "connected" }),
          webhook: async () => ({ status: 200 }),
          stop: async () => {},
        }),
      };
      fx = await startChannelFixture([]);
      await fx.ctx.channels.initialize(new Map([["legacy", legacy]]));
      const connected = await fx.harness.api<{ connection: { id: string } }>(
        "POST",
        `/api/workspaces/${fx.workspace.id}/channels/legacy/connect`,
        { method: "plain", botId: fx.alice.id, config: {} },
      );
      const blocks = `/api/workspaces/${fx.workspace.id}/channel-connections/${connected.json.connection.id}/blocks`;
      expect((await fx.harness.api("POST", blocks, { senderId: "u1" })).status).toBe(409);
      expect((await fx.harness.api("GET", blocks)).status).toBe(409);
      expect((await fx.rebind(connected.json.connection.id, fx.bob.id)).status).toBe(409);
    });
  },
);
