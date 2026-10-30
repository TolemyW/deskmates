// T1, ADR-0047 decisions 9 to 11: the ABI-2 host reaches only its own connection's current
// threads, refuses a stale handle with `channel_connection_stale` and no effect, keeps identical
// provider ids of different connections and workspaces apart, deduplicates redeliveries, and
// stamps the connection on the runs it starts. The ABI-1 host is narrowed to its workspaces.

import type {
  ApprovalId,
  ChannelConnectionFrame,
  ChannelConnectionHost,
  ChannelPlugin,
  ChannelPluginHost,
  ThreadId,
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
  fake.addAccount("tok-b", { accountId: "2", label: "B" });
  fake.addAccount("tok-c", { accountId: "3", label: "C" });
  return fake;
}

function counts(f: ChannelFixture) {
  const n = (sql: string) => (f.ctx.db.prepare(sql).get() as { n: number }).n;
  return {
    threads: n("SELECT count(*) AS n FROM threads"),
    messages: n("SELECT count(*) AS n FROM thread_messages"),
    runs: n("SELECT count(*) AS n FROM runs"),
    receipts: n("SELECT count(*) AS n FROM channel_outbound_receipts"),
    decided: n("SELECT count(*) AS n FROM approvals WHERE decision IS NOT NULL"),
  };
}

async function two(f: ChannelFixture, fake: FakeChannelProvider) {
  const a = (await f.connect({ pluginId: "fakechat", token: "tok-a", botId: f.alice.id })).json
    .connection;
  const b = (await f.connect({ pluginId: "fakechat", token: "tok-b", botId: f.bob.id })).json
    .connection;
  const inB = await fake.deliver(b.id, { senderId: "u9", externalId: "b-1", body: "for bob" });
  if (inB.status !== "posted") throw new Error("not posted");
  return { a, b, threadOfB: inB.thread.id, runOfB: inB.runs[0]?.id };
}

describe("the connection-scoped host (ADR-0047 decision 9)", { timeout: 30_000 }, () => {
  it("gives a hostile plugin nothing of another connection's threads or approvals (V3)", async () => {
    const fake = provider();
    fx = await startChannelFixture([fake]);
    const { a, threadOfB, runOfB } = await two(fx, fake);
    fx.ctx.approvals.create({
      id: "apr_b" as ApprovalId,
      runId: runOfB as never,
      botId: fx.bob.id,
      threadId: threadOfB as ThreadId,
      action: { toolName: "Bash", input: { command: "curl https://x.test" } },
      riskLevel: "L2",
    });
    const hostA = fake.host(a.id);
    const before = counts(fx);
    const refusals = [
      hostA.getThread(threadOfB),
      hostA.syncActivity?.(threadOfB),
      hostA.listMessages(threadOfB, 0),
      hostA.conversationKeyOf(threadOfB),
      hostA.beginSend({ threadId: threadOfB, seq: 1 }),
      hostA.recordSend({ threadId: threadOfB, seq: 1, providerMessageIds: ["x"] }),
      hostA.decideApproval({ id: "apr_b", decision: "allow_once", senderId: "u9" }),
    ];
    for (const refusal of refusals)
      await expect(refusal).rejects.toMatchObject({ code: "not_found" });
    expect(await hostA.getApproval("apr_b")).toBeUndefined();
    expect(await hostA.findThread("u9")).toBeUndefined();
    expect(counts(fx)).toEqual(before);

    // Subscribe: A sees no frame of B's thread.
    const frames: ChannelConnectionFrame[] = [];
    const abort = new AbortController();
    void hostA.subscribe(
      { onOpen: () => {}, onFrame: (frame) => void frames.push(frame) },
      abort.signal,
    );
    await new Promise((done) => setTimeout(done, 10));
    fx.reply(threadOfB, fx.bob.id, "bob's reply");
    await new Promise((done) => setTimeout(done, 20));
    abort.abort();
    expect(frames.filter((frame) => frame.threadId === threadOfB)).toEqual([]);
  });

  it("refuses every call of a stale handle with channel_connection_stale and no effect (V3)", async () => {
    const fake = provider();
    fx = await startChannelFixture([fake]);
    const { a } = await two(fx, fake);
    const posted = await fake.deliver(a.id, { senderId: "u1", externalId: "a-1", body: "hi" });
    if (posted.status !== "posted") throw new Error("not posted");
    fx.reply(posted.thread.id, fx.alice.id, "reply");
    await fake.settle();
    const stale: ChannelConnectionHost = fake.host(a.id);
    expect((await fx.command(a.id, "reconnect")).status).toBe(200);
    expect(fake.host(a.id)).not.toBe(stale);
    const before = counts(fx);
    const calls = [
      stale.receive({ conversationKey: "u1", senderId: "u1", externalId: "a-2", body: "late" }),
      stale.findThread("u1"),
      stale.listThreads?.(),
      stale.syncActivity?.(posted.thread.id),
      stale.getThread(posted.thread.id),
      stale.listMessages(posted.thread.id, 0),
      stale.beginSend({ threadId: posted.thread.id, seq: 2 }),
      stale.recordSend({ threadId: posted.thread.id, seq: 2, providerMessageIds: ["late"] }),
      stale.getApproval("apr_none"),
      stale.decideApproval({ id: "apr_none", decision: "deny", senderId: "u1" }),
      stale.subscribe({ onOpen: () => {}, onFrame: () => {} }, new AbortController().signal),
    ];
    for (const call of calls)
      await expect(call).rejects.toMatchObject({ code: "channel_connection_stale" });
    expect(counts(fx)).toEqual(before);
    // The current handle still works, and so does every call after a disconnect: none.
    const current = fake.host(a.id);
    expect((await current.getThread(posted.thread.id)).thread.id).toBe(posted.thread.id);
    expect((await fx.command(a.id, "disconnect")).status).toBe(200);
    await expect(current.findThread("u1")).rejects.toMatchObject({
      code: "channel_connection_stale",
    });
  });

  it("keeps identical provider ids of two connections and two workspaces apart, and posts a redelivery once (decisions 10, 11)", async () => {
    const fake = provider();
    fx = await startChannelFixture([fake]);
    const { a, b } = await two(fx, fake);
    const c = (
      await fx.connect({
        pluginId: "fakechat",
        token: "tok-c",
        botId: fx.other.carol.id,
        workspaceId: fx.other.workspace.id,
      })
    ).json.connection;
    const same = { senderId: "same-user", externalId: "same-event", body: "same text" };
    const results = [
      await fake.deliver(a.id, same),
      await fake.deliver(b.id, same),
      await fake.deliver(c.id, same),
    ];
    const threads = results.map((r) => (r.status === "posted" ? r.thread : undefined));
    expect(new Set(threads.map((t) => t?.id)).size).toBe(3);
    expect(threads.map((t) => t?.workspaceId)).toEqual([
      fx.workspace.id,
      fx.workspace.id,
      fx.other.workspace.id,
    ]);
    expect(threads.map((t) => t?.externalKey)).toEqual([
      `${a.id}:1:same-user`,
      `${b.id}:1:same-user`,
      `${c.id}:1:same-user`,
    ]);
    const runsBefore = fx.ctx.runs.list({}).length;
    const again = await fake.deliver(a.id, same);
    expect(again).toMatchObject({ status: "duplicate", threadId: threads[0]?.id });
    expect(fx.ctx.runs.list({}).length).toBe(runsBefore);

    // Every run a channel message started names its connection, plugin and generation.
    const first = results[0];
    if (first?.status !== "posted") throw new Error("not posted");
    const run = fx.ctx.runs.mustGet(first.runs[0]?.id as never);
    expect(run.config.channelConnection).toEqual({
      id: a.id,
      pluginId: "fakechat",
      bindingGeneration: 1,
    });
    // A Web chat of the same Bot is a different thread with no connection stamp.
    const web = fx.ctx.threads.create({ workspaceId: fx.workspace.id, botIds: [fx.alice.id] });
    expect(web.channelConnectionId).toBeUndefined();
  });

  it("records each relayed message once and refuses to send it twice (send gate)", async () => {
    const fake = provider();
    fx = await startChannelFixture([fake]);
    const { a } = await two(fx, fake);
    const posted = await fake.deliver(a.id, { senderId: "u1", externalId: "a-1", body: "hi" });
    if (posted.status !== "posted") throw new Error("not posted");
    fx.reply(posted.thread.id, fx.alice.id, "one");
    await fake.settle();
    const host = fake.host(a.id);
    expect(await host.beginSend({ threadId: posted.thread.id, seq: 1 })).toEqual({
      send: false,
      reason: "sender_message",
    });
    expect(await host.beginSend({ threadId: posted.thread.id, seq: 2 })).toEqual({
      send: false,
      reason: "already_sent",
    });
    const receipt = fx.ctx.db
      .prepare(
        "SELECT state, connection_id, binding_generation, credential_generation, provider_message_id FROM channel_outbound_receipts WHERE thread_id = ?",
      )
      .all(posted.thread.id);
    expect(receipt).toEqual([
      {
        state: "sent",
        connection_id: a.id,
        binding_generation: 1,
        credential_generation: 1,
        provider_message_id: fake.deliveries[0]?.providerMessageId,
      },
    ]);
  });
});

describe(
  "the ABI-1 plugin-wide host is narrowed (ADR-0047 decision 9)",
  { timeout: 30_000 },
  () => {
    it("reaches only workspaces where its plugin has a connection, never an ABI-2 thread", async () => {
      let captured: ChannelPluginHost | undefined;
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
        create: async (host) => {
          captured = host;
          return {
            connect: async () => ({ phase: "connected" }),
            restore: async () => ({ phase: "connected" }),
            status: async () => ({ phase: "connected" }),
            command: async () => ({ phase: "connected" }),
            webhook: async () => ({ status: 200 }),
            stop: async () => {},
          };
        },
      };
      const fake = provider();
      fx = await startChannelFixture([fake]);
      // The fixture's plugins are fixed at start; add the ABI-1 plugin the way initialize does.
      await fx.ctx.channels.initialize(
        new Map<string, ChannelPlugin | typeof fake.plugin>([
          ["legacy", legacy],
          ["fakechat", fake.plugin],
        ]),
      );
      const host = captured as ChannelPluginHost;
      await expect(host.findThread(fx.workspace.id, "legacy", "k")).rejects.toMatchObject({
        code: "not_found",
      });
      const connected = await fx.harness.api<{ connection: { id: string } }>(
        "POST",
        `/api/workspaces/${fx.workspace.id}/channels/legacy/connect`,
        { method: "plain", botId: fx.alice.id, config: {} },
      );
      expect(connected.status).toBe(201);
      const thread = await host.createThread({
        workspaceId: fx.workspace.id,
        botId: fx.alice.id,
        channel: "legacy",
        externalKey: "k",
        title: "Legacy k",
      });
      expect(await host.findThread(fx.workspace.id, "legacy", "k")).toMatchObject({
        id: thread.id,
      });
      await expect(
        host.createThread({
          workspaceId: fx.other.workspace.id,
          botId: fx.other.carol.id,
          channel: "legacy",
          externalKey: "k",
          title: "x",
        }),
      ).rejects.toMatchObject({ code: "not_found" });
      const a = (await fx.connect({ pluginId: "fakechat", token: "tok-a", botId: fx.alice.id }))
        .json.connection;
      const abi2 = await fake.deliver(a.id, { senderId: "u1", externalId: "e", body: "x" });
      if (abi2.status !== "posted") throw new Error("not posted");
      await expect(host.getThread(abi2.thread.id)).rejects.toMatchObject({ code: "not_found" });
      await expect(
        host.postHumanMessage({
          threadId: abi2.thread.id,
          body: "x",
          authorId: "legacy:1",
          externalId: "z",
        }),
      ).rejects.toMatchObject({ code: "not_found" });
    });
  },
);

it("recovers scoped activity without waking work or repeating notices", async () => {
  const fake = provider();
  fx = await startChannelFixture([fake]);
  const { a, threadOfB } = await two(fx, fake);
  const posted = await fake.deliver(a.id, {
    senderId: "u1",
    externalId: "a-1",
    body: "watch this",
  });
  if (posted.status !== "posted" || !posted.runs[0]) throw new Error("not posted");
  const host = fake.host(a.id);
  expect(await host.listThreads?.()).toEqual([posted.thread.id]);
  expect(await host.listThreads?.()).not.toContain(threadOfB);
  const run = posted.runs[0];
  const before = counts(fx).runs;
  await host.syncActivity?.(posted.thread.id);
  expect(await host.listMessages(posted.thread.id, 0)).toHaveLength(1);
  fx.ctx.runs.transition(run.id, "running");
  fx.ctx.runs.transition(run.id, "waiting_browser");
  await host.syncActivity?.(posted.thread.id);
  await host.syncActivity?.(posted.thread.id);
  expect(await host.listMessages(posted.thread.id, 0)).toHaveLength(2);
  fx.ctx.runs.transition(run.id, "running");
  await host.syncActivity?.(posted.thread.id);
  expect((await host.listMessages(posted.thread.id, 0)).at(-1)?.body).toContain("resumed");
  fx.ctx.runs.transition(run.id, "failed");
  await host.syncActivity?.(posted.thread.id);
  await host.syncActivity?.(posted.thread.id);
  expect(await host.listMessages(posted.thread.id, 0)).toHaveLength(4);
  expect(counts(fx).runs).toBe(before);
});

it("subscribes before recovering the initial snapshot", async () => {
  const fake = provider();
  fx = await startChannelFixture([fake]);
  const { b, threadOfB } = await two(fx, fake);
  const frames: ChannelConnectionFrame[] = [];
  const abort = new AbortController();
  const fixture = fx;
  await fake.host(b.id).subscribe(
    {
      onOpen: () => {
        fixture.reply(threadOfB, fixture.bob.id, "during recovery");
        abort.abort();
      },
      onFrame: (frame) => {
        frames.push(frame);
      },
    },
    abort.signal,
  );
  expect(frames.some((frame) => frame.type === "thread_message")).toBe(true);
});
