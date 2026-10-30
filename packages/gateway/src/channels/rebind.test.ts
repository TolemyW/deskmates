// T1, ADR-0047 decision 8: a rebind fences the old binding generation first, then cancels its
// runs, closes its approvals `binding_changed` and records its unsent outbound `cancelled`; the
// old thread stays a read-only mirror under the old Bot, nothing moves, and the person gets one
// notice naming the new assistant before the first reply.

import {
  type ApprovalId,
  type RunId,
  type ThreadId,
  channelRebindNotice,
  isTerminal,
} from "@deskmates/contracts";
import { FakeChannelProvider } from "@deskmates/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { type ChannelFixture, startChannelFixture } from "../test-support/channel-connections.js";

let fx: ChannelFixture | undefined;
afterEach(async () => {
  await fx?.close();
  fx = undefined;
});

function provider() {
  const fake = new FakeChannelProvider();
  fake.addAccount("tok-a", { accountId: "1", label: "A" });
  return fake;
}

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("condition not reached");
    await new Promise((done) => setTimeout(done, 10));
  }
}

describe(
  "rebinding a connection to another Bot (ADR-0047 decision 8, V4)",
  { timeout: 30_000 },
  () => {
    it("fences the old generation, retires its work, keeps its history and notices the person once", async () => {
      const fake = provider();
      fx = await startChannelFixture([fake]);
      const f = fx;
      const connection = (
        await f.connect({ pluginId: "fakechat", token: "tok-a", botId: f.alice.id })
      ).json.connection;
      const oldHost = fake.host(connection.id);
      const first = await fake.deliver(connection.id, {
        senderId: "u1",
        externalId: "e1",
        body: "hi",
      });
      if (first.status !== "posted") throw new Error("not posted");
      const oldThread = first.thread.id;
      const runId = first.runs[0]?.id as RunId;
      await waitFor(() => f.ctx.runs.mustGet(runId).status === "running");
      f.ctx.approvals.create({
        id: "apr_old" as ApprovalId,
        runId,
        botId: f.alice.id,
        threadId: oldThread as ThreadId,
        action: { toolName: "Bash", input: { command: "curl https://x.test" } },
        riskLevel: "L2",
      });
      // Alice's reply is queued at the provider when the rebind happens.
      let release: () => void = () => {};
      fake.hold = new Promise((done) => {
        release = done;
      });
      f.reply(oldThread, f.alice.id, "queued reply from alice");
      const messagesBefore = f.ctx.messages.list(oldThread as ThreadId).length;

      const rebound = await f.rebind(connection.id, f.bob.id);
      expect(rebound.status).toBe(200);
      expect(rebound.json.connection).toMatchObject({ botId: f.bob.id, bindingGeneration: 2 });
      expect(rebound.json.fence.runsCancelled).toBe(1);
      expect(rebound.json.fence.outboundCancelled).toBeGreaterThanOrEqual(1);
      expect(fake.closes).toContainEqual({ connectionId: connection.id, reason: "rebind" });
      expect(fake.request(connection.id)).toMatchObject({
        reason: "rebind",
        botId: f.bob.id,
        bindingGeneration: 2,
      });

      // The queued send finds its handle stale: nothing of the old generation goes out.
      release();
      fake.hold = undefined;
      await fake.settle();
      expect(fake.deliveries).toEqual([]);
      const reply = f.ctx.messages
        .list(oldThread as ThreadId)
        .find((m) => m.body === "queued reply from alice");
      expect(
        f.ctx.db
          .prepare(
            "SELECT state, reason, binding_generation FROM channel_outbound_receipts WHERE thread_id = ? AND message_seq = ?",
          )
          .get(oldThread, reply?.seq),
      ).toEqual({ state: "cancelled", reason: "binding_changed", binding_generation: 1 });
      expect(isTerminal(f.ctx.runs.mustGet(runId).status)).toBe(true);
      expect(f.ctx.runs.mustGet(runId).status).toBe("cancelled");
      expect(f.ctx.approvals.mustGet("apr_old" as ApprovalId)).toMatchObject({
        decision: "deny",
        decidedBy: "system:channel_binding",
        reason: "binding_changed",
      });
      await expect(
        fake.deliver(connection.id, { senderId: "u1", externalId: "e-late", body: "x" }, oldHost),
      ).rejects.toMatchObject({ code: "channel_connection_stale" });

      // The old thread stays, read-only, with Alice; only the fence's own notices were added.
      const kept = f.ctx.threads.mustGet(oldThread as ThreadId);
      expect(kept).toMatchObject({ channel: "fakechat", bindingGeneration: 1 });
      expect(f.ctx.threads.members(kept.id).map((m) => m.botId)).toEqual([f.alice.id]);
      const added = f.ctx.messages.list(oldThread as ThreadId).slice(messagesBefore);
      expect(added.every((m) => m.authorKind === "system")).toBe(true);

      // The next message starts a new thread for Bob, which opens with the notice.
      const next = await fake.deliver(connection.id, {
        senderId: "u1",
        externalId: "e2",
        body: "again",
      });
      if (next.status !== "posted") throw new Error("not posted");
      expect(next.thread.id).not.toBe(oldThread);
      expect(f.ctx.threads.members(next.thread.id).map((m) => m.botId)).toEqual([f.bob.id]);
      const opening = f.ctx.messages.list(next.thread.id);
      expect(opening.map((m) => [m.authorKind, m.body])).toEqual([
        ["system", channelRebindNotice("bob")],
        ["human", "again"],
      ]);
      expect(opening.some((m) => m.body === "hi")).toBe(false);
      f.reply(next.thread.id, f.bob.id, "hello, bob here");
      await fake.settle();
      expect(fake.deliveries.map((d) => d.body)).toEqual([
        channelRebindNotice("bob"),
        "hello, bob here",
      ]);

      // Once per conversation: the same person again, and a person new after the rebind, get none.
      await fake.deliver(connection.id, { senderId: "u1", externalId: "e3", body: "third" });
      const newcomer = await fake.deliver(connection.id, {
        senderId: "u2",
        externalId: "e4",
        body: "first time",
      });
      if (newcomer.status !== "posted") throw new Error("not posted");
      const notices = (threadId: string) =>
        f.ctx.messages
          .list(threadId as ThreadId)
          .filter((m) => m.body === channelRebindNotice("bob")).length;
      expect(notices(next.thread.id)).toBe(1);
      expect(notices(newcomer.thread.id)).toBe(0);

      const audit = f.ctx.db
        .prepare("SELECT before_json, after_json FROM audit_events WHERE action = 'channel.rebind'")
        .get() as { before_json: string; after_json: string };
      expect(JSON.parse(audit.before_json)).toEqual({ botId: f.alice.id, bindingGeneration: 1 });
      expect(JSON.parse(audit.after_json)).toMatchObject({ botId: f.bob.id, bindingGeneration: 2 });
    });

    it("refuses a rebind to the same Bot, to another workspace's Bot, and from another workspace", async () => {
      const fake = provider();
      fx = await startChannelFixture([fake]);
      const connection = (
        await fx.connect({ pluginId: "fakechat", token: "tok-a", botId: fx.alice.id })
      ).json.connection;
      expect((await fx.rebind(connection.id, fx.alice.id)).status).toBe(409);
      expect((await fx.rebind(connection.id, fx.other.carol.id)).status).toBe(400);
      expect(
        fx.ctx.db.prepare("SELECT binding_generation AS g FROM channel_connections").get(),
      ).toEqual({
        g: 1,
      });
      // Another workspace's connection id is not found from this workspace.
      const elsewhere = await fx.harness.api<{ code: string }>(
        "POST",
        `/api/workspaces/${fx.other.workspace.id}/channel-connections/${connection.id}/rebind`,
        { botId: fx.other.carol.id },
      );
      expect(elsewhere.status).toBe(404);
    });
  },
);
