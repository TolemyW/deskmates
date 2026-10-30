// T1: the Slack plugin's runtime against a scripted Slack (`testing/fake-slack.ts`) and a fake
// connection-scoped host (`testing/fake-host.ts`). Covers ADR-0047's per-plugin rows for Slack:
// identity from `auth.test` (decision 6), 1:1 only and inbound images (12), the send gate and
// at-least-once relay (9, 11), credentials kept out of logs, statuses and state (14). Nothing here
// talks to Slack; no live behaviour is established by these tests.

import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BotId,
  type ChannelOpenRequest,
  type WorkspaceId,
  channelManifestV2Problems,
} from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { SLACK_NOTICES } from "./connection.js";
import { channelPlugin } from "./plugin.js";
import { SLACK_METHOD_ID, SlackRuntime } from "./runtime.js";
import { SLACK_STATE_FILE } from "./state.js";
import { FakeConnectionHost } from "./testing/fake-host.js";
import {
  FakeSlack,
  type FakeSlackInstall,
  messageEnvelope,
  revocationEnvelope,
} from "./testing/fake-slack.js";

const BOT_TOKEN = "xoxb-1111-secret-bot-token-aaaa";
const APP_TOKEN = "xapp-1-A0APP1-secret-app-token-bbbb";
const BOT_TOKEN_2 = "xoxb-2222-secret-bot-token-cccc";
const APP_TOKEN_2 = "xapp-1-A0APP2-secret-app-token-dddd";
const SECRETS = [BOT_TOKEN, APP_TOKEN, BOT_TOKEN_2, APP_TOKEN_2];

const ACME: FakeSlackInstall = {
  teamId: "T0ACME",
  teamName: "Acme",
  appId: "A0APP1",
  botId: "B0BOT1",
  botUserId: "U0BOT1",
  botName: "deskbot",
};

const GLOBEX: FakeSlackInstall = {
  teamId: "T0GLOBEX",
  teamName: "Globex",
  appId: "A0APP2",
  botId: "B0BOT2",
  botUserId: "U0BOT2",
  botName: "helper",
};

const PERSON = "U0PERSON";
const DM = "D0PERSON1";

async function until(check: () => boolean, label = "condition", ms = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${label}`);
    await new Promise((done) => setTimeout(done, 5));
  }
}

const settle = () => new Promise((done) => setTimeout(done, 30));

let runtimes: SlackRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.map((runtime) => runtime.stop()));
  runtimes = [];
});

function setup(options: { ackDeadlineMs?: number } = {}) {
  const slack = new FakeSlack();
  slack.install(BOT_TOKEN, APP_TOKEN, ACME);
  slack.install(BOT_TOKEN_2, APP_TOKEN_2, GLOBEX);
  const runtime = new SlackRuntime({
    transport: slack,
    sleep: async () => {},
    timings: {
      reconnectDelayMs: () => 5,
      relayRetryMs: () => 5,
      ackDeadlineMs: options.ackDeadlineMs ?? 1000,
    },
  });
  runtimes.push(runtime);
  return { slack, runtime };
}

function openRequest(
  connectionId: string,
  overrides: Partial<ChannelOpenRequest> = {},
): ChannelOpenRequest {
  return {
    connectionId,
    workspaceId: "ws_1" as WorkspaceId,
    botId: "bot_1" as BotId,
    identityKey: "slack:T0ACME:A0APP1",
    bindingGeneration: 1,
    credentialGeneration: 1,
    reason: "connect",
    method: SLACK_METHOD_ID,
    config: {},
    secrets: { botToken: BOT_TOKEN, appToken: APP_TOKEN },
    stateDirectory: join(mkdtempSync(join(tmpdir(), "slack-state-")), connectionId),
    ...overrides,
  };
}

async function openConnected(
  runtime: SlackRuntime,
  slack: FakeSlack,
  connectionId = "conn_1",
  overrides: Partial<ChannelOpenRequest> = {},
) {
  const host = new FakeConnectionHost(connectionId);
  const request = openRequest(connectionId, overrides);
  const sockets = slack.sockets.length;
  await runtime.open(request, host);
  await until(() => slack.sockets.length > sockets, "socket");
  const socket = slack.lastSocket;
  // `status` is async in the ABI; the connection object answers synchronously.
  await until(() => runtime.connection(connectionId)?.status().phase === "connected", "connected");
  return { host, socket, request };
}

const dm = (
  envelopeId: string,
  eventId: string,
  extra: Partial<Parameters<typeof messageEnvelope>[0]> = {},
) => messageEnvelope({ envelopeId, eventId, install: ACME, user: PERSON, channel: DM, ...extra });

describe("Slack manifest (ADR-0047 decision 12)", () => {
  it("is a loadable ABI-2 manifest with an honest capability matrix", () => {
    expect(channelManifestV2Problems(channelPlugin.manifest)).toEqual([]);
    expect(channelPlugin.manifest).toMatchObject({
      id: "slack",
      multipleConnections: true,
      capabilities: {
        directMessages: "available",
        groups: "unavailable",
        inboundImages: "available",
        inboundOtherMedia: "disabled",
        outboundReply: "available",
        proactiveMessages: "unavailable",
        streaming: "disabled",
        testMessage: "unavailable",
      },
    });
    const fields = channelPlugin.manifest.methods.flatMap((method) => method.fields);
    expect(fields.map((field) => [field.key, field.secret])).toEqual([
      ["botToken", true],
      ["appToken", true],
    ]);
  });
});

describe("verify (ADR-0047 decisions 6 and 7)", () => {
  it("derives the identity from auth.test and bots.info, not from the input", async () => {
    const { runtime, slack } = setup();
    const identity = await runtime.verify({
      workspaceId: "ws_1" as WorkspaceId,
      method: SLACK_METHOD_ID,
      config: { identityKey: "slack:T0EVIL:A0EVIL" },
      secrets: { botToken: BOT_TOKEN, appToken: APP_TOKEN },
    });
    expect(identity).toEqual({ identityKey: "slack:T0ACME:A0APP1", label: "deskbot in Acme" });
    expect(slack.calls.map((call) => call.method)).toEqual([
      "auth.test",
      "bots.info",
      "apps.connections.open",
    ]);
    expect(slack.sockets).toHaveLength(0);
  });

  it("gives the same app in another Slack workspace another identity, and a second token of one installation the same", async () => {
    const { runtime, slack } = setup();
    slack.install("xoxb-acme-rotated", "xapp-acme-rotated", ACME);
    slack.install("xoxb-other-team", "xapp-other-team", {
      ...ACME,
      teamId: "T0OTHER",
      botId: "B0X",
      botUserId: "U0X",
    });
    const verify = (botToken: string, appToken: string) =>
      runtime.verify({
        workspaceId: "ws_1" as WorkspaceId,
        method: SLACK_METHOD_ID,
        config: {},
        secrets: { botToken, appToken },
      });
    const first = await verify(BOT_TOKEN, APP_TOKEN);
    expect((await verify("xoxb-acme-rotated", "xapp-acme-rotated")).identityKey).toBe(
      first.identityKey,
    );
    expect((await verify("xoxb-other-team", "xapp-other-team")).identityKey).toBe(
      "slack:T0OTHER:A0APP1",
    );
  });

  it("names an org-wide install by its enterprise", async () => {
    const { runtime, slack } = setup();
    slack.install("xoxb-grid", "xapp-grid", {
      ...ACME,
      teamId: "",
      enterpriseId: "E0GRID",
      enterpriseInstall: true,
    });
    const identity = await runtime.verify({
      workspaceId: "ws_1" as WorkspaceId,
      method: SLACK_METHOD_ID,
      config: {},
      secrets: { botToken: "xoxb-grid", appToken: "xapp-grid" },
    });
    expect(identity.identityKey).toBe("slack:E0GRID:A0APP1");
  });

  it("refuses invalid tokens without repeating them", async () => {
    const { runtime } = setup();
    const attempt = (botToken: string, appToken: string) =>
      runtime.verify({
        workspaceId: "ws_1" as WorkspaceId,
        method: SLACK_METHOD_ID,
        config: {},
        secrets: { botToken, appToken },
      });
    const failures = await Promise.all([
      attempt("xoxb-unknown-secret-1", APP_TOKEN).catch((error: Error) => error.message),
      attempt(BOT_TOKEN, "xapp-unknown-secret-2").catch((error: Error) => error.message),
      attempt("xoxp-user-token-secret-3", APP_TOKEN).catch((error: Error) => error.message),
      attempt(BOT_TOKEN, "not-an-app-token-secret-4").catch((error: Error) => error.message),
    ]);
    expect(failures[0]).toMatch(/auth\.test failed: invalid_auth/);
    expect(failures[1]).toMatch(/apps\.connections\.open failed: invalid_auth/);
    expect(failures[2]).toMatch(/starts with xoxb-/);
    expect(failures[3]).toMatch(/starts with xapp-/);
    for (const message of failures) expect(message).not.toMatch(/secret/);
  });
});

describe("Socket Mode inbound", () => {
  it("posts a DM's text, acknowledges the envelope and relays the reply", async () => {
    const { runtime, slack } = setup();
    const { host, socket } = await openConnected(runtime, slack);
    socket.emit(
      dm("env-1", "Ev001", {
        text: "hello &lt;team&gt; see <https://example.com|the docs> <@U0BOT1>",
      }),
    );
    await until(() => socket.acks.includes("env-1"), "ack");
    expect(host.receives).toEqual([
      {
        conversationKey: DM,
        senderId: PERSON,
        externalId: "Ev001",
        body: "hello <team> see the docs (https://example.com) @U0BOT1",
      },
    ]);
    const thread = host.threadOf(DM);
    expect(thread).toBeDefined();
    host.reply(thread?.thread.id ?? "", "Hi <there> & welcome");
    await until(() => slack.posts.length === 1, "reply");
    expect(slack.posts[0]).toMatchObject({
      token: BOT_TOKEN,
      channel: DM,
      text: "Hi &lt;there&gt; &amp; welcome",
    });
    // The person's own message was never echoed, and the send was recorded with Slack's ts.
    expect(host.receipts.get(`${thread?.thread.id}:2`)).toEqual({
      state: "sent",
      ids: [slack.posts[0]?.ts],
    });
  });

  it("receives image files with the bot token and refuses other files with a notice", async () => {
    const { runtime, slack } = setup();
    const { host, socket } = await openConnected(runtime, slack);
    const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    slack.addFile("https://files.slack.com/files-pri/T0ACME-F1/download/cat.png", {
      status: 200,
      contentType: "image/png",
      bytes: png,
    });
    socket.emit(
      dm("env-2", "Ev002", {
        subtype: "file_share",
        text: "look",
        files: [
          {
            id: "F1",
            name: "cat.png",
            mimetype: "image/png",
            size: png.byteLength,
            url_private_download: "https://files.slack.com/files-pri/T0ACME-F1/download/cat.png",
          },
          {
            id: "F2",
            name: "notes.pdf",
            mimetype: "application/pdf",
            size: 10,
            url_private_download: "https://files.slack.com/files-pri/T0ACME-F2/download/notes.pdf",
          },
          {
            id: "F3",
            name: "evil.png",
            mimetype: "image/png",
            size: 10,
            url_private_download: "https://attacker.example/steal.png",
          },
        ],
      }),
    );
    await until(() => socket.acks.includes("env-2"), "ack");
    expect(slack.downloads).toEqual([
      {
        url: "https://files.slack.com/files-pri/T0ACME-F1/download/cat.png",
        token: BOT_TOKEN,
      },
    ]);
    const received = host.receives[0];
    expect(received?.body).toBe("look");
    expect(received?.images).toEqual([{ name: "cat.png", mimeType: "image/png", bytes: png }]);
    expect(slack.posts.map((post) => post.text)).toEqual([
      SLACK_NOTICES.otherMedia(1),
      SLACK_NOTICES.imagesRefused(1),
    ]);
  });

  it("tells the person when only a refused file arrived, without posting anything", async () => {
    const { runtime, slack } = setup();
    const { host, socket } = await openConnected(runtime, slack);
    socket.emit(
      dm("env-3", "Ev003", {
        subtype: "file_share",
        files: [
          {
            id: "F9",
            name: "voice.m4a",
            mimetype: "audio/mp4",
            size: 5,
            url_private_download: "https://files.slack.com/x",
          },
        ],
      }),
    );
    await until(() => socket.acks.includes("env-3"), "ack");
    expect(host.allThreads()).toEqual([]);
    expect(slack.posts.map((post) => post.text)).toEqual([SLACK_NOTICES.otherMedia(1)]);
  });

  it("ignores channels, private channels, multi-person DMs, edits and bot messages; refuses DM thread replies", async () => {
    const { runtime, slack } = setup();
    const { host, socket } = await openConnected(runtime, slack);
    socket.emit(
      dm("e-ch", "EvC1", { channel: "C0GENERAL", channelType: "channel", text: "hi all" }),
    );
    socket.emit(dm("e-gr", "EvC2", { channel: "G0PRIVATE", channelType: "group", text: "hi" }));
    socket.emit(dm("e-mp", "EvC3", { channel: "G0MPIM", channelType: "mpim", text: "hi" }));
    socket.emit(
      dm("e-thr-ch", "EvC4", {
        channel: "C0GENERAL",
        channelType: "channel",
        threadTs: "1.0",
        text: "re",
      }),
    );
    socket.emit(dm("e-edit", "EvC5", { subtype: "message_changed" }));
    socket.emit(dm("e-bot", "EvC6", { user: "U0BOT1", botId: "B0BOT1", text: "my own reply" }));
    socket.emit(dm("e-thr-dm", "EvC7", { threadTs: "1699999999.000001", text: "in a thread" }));
    await until(() => socket.acks.length === 7, "acks");
    await settle();
    expect(host.allThreads()).toEqual([]);
    // Only the DM thread reply reached the host, as an empty probe that posts nothing.
    expect(host.receives.map((input) => [input.externalId, input.body])).toEqual([["EvC7", ""]]);
    expect(slack.posts.map((post) => post.text)).toEqual([SLACK_NOTICES.threadReply]);
  });

  it("ignores events for another app or Slack workspace", async () => {
    const { runtime, slack } = setup();
    const { host, socket } = await openConnected(runtime, slack);
    socket.emit(
      messageEnvelope({
        envelopeId: "e-x",
        eventId: "EvX",
        install: GLOBEX,
        user: PERSON,
        channel: DM,
        text: "hi",
      }),
    );
    await until(() => socket.acks.includes("e-x"), "ack");
    expect(host.receives).toEqual([]);
  });

  it("drops a blocklisted sender's message and sends them nothing", async () => {
    const { runtime, slack } = setup();
    const { host, socket } = await openConnected(runtime, slack);
    host.blocked.add(PERSON);
    socket.emit(dm("env-b1", "EvB1", { text: "let me in" }));
    socket.emit(
      dm("env-b2", "EvB2", {
        subtype: "file_share",
        files: [
          {
            id: "F",
            name: "a.mp4",
            mimetype: "video/mp4",
            size: 1,
            url_private_download: "https://files.slack.com/v",
          },
        ],
      }),
    );
    socket.emit(dm("env-b3", "EvB3", { threadTs: "1.0", text: "thread" }));
    await until(() => socket.acks.length === 3, "acks");
    await settle();
    expect(host.allThreads()).toEqual([]);
    expect(slack.posts).toEqual([]);
  });

  it("ignores a redelivered envelope with the same event id", async () => {
    const { runtime, slack } = setup();
    const { host, socket } = await openConnected(runtime, slack);
    socket.emit(dm("env-d1", "EvD1", { text: "once" }));
    await until(() => socket.acks.includes("env-d1"), "first ack");
    socket.emit(dm("env-d2", "EvD1", { text: "once", retryAttempt: 1 }));
    await until(() => socket.acks.includes("env-d2"), "second ack");
    expect(host.receives).toHaveLength(1);
    expect(runtime.connection("conn_1")?.status().details).toMatchObject({ duplicateEvents: 1 });
  });

  it("leaves an envelope unacknowledged when the Gateway fails, so Slack redelivers it", async () => {
    const { runtime, slack } = setup();
    const { host, socket } = await openConnected(runtime, slack);
    const original = host.receive.bind(host);
    let failures = 1;
    host.receive = async (input) => {
      if (failures-- > 0) throw new Error("gateway restarting");
      return original(input);
    };
    socket.emit(dm("env-f1", "EvF1", { text: "are you there" }));
    await settle();
    expect(socket.acks).toEqual([]);
    socket.emit(dm("env-f2", "EvF1", { text: "are you there", retryAttempt: 1 }));
    await until(() => socket.acks.includes("env-f2"), "retry ack");
    expect(host.allThreads()).toHaveLength(1);
  });

  it("decides an approval of the person's own thread and never posts the command", async () => {
    const { runtime, slack } = setup();
    const { host, socket } = await openConnected(runtime, slack);
    socket.emit(dm("env-a1", "EvA1", { text: "send the report" }));
    await until(() => host.allThreads().length === 1, "thread");
    const threadId = host.allThreads()[0]?.thread.id ?? "";
    const approvalId = "11111111-2222-4333-8444-555555555555";
    host.requestApproval(threadId, approvalId);
    await until(() => slack.posts.length === 1, "approval relayed");
    expect(slack.posts[0]?.text).toContain(`Reply "approve ${approvalId}"`);
    socket.emit(dm("env-a2", "EvA2", { text: `approve ${approvalId}`, ts: "1700000000.000200" }));
    await until(() => host.decisions.length === 1, "decision");
    expect(host.decisions[0]).toEqual({ id: approvalId, decision: "allow_once", senderId: PERSON });
    expect(host.threadOf(DM)?.messages.map((message) => message.body)).not.toContain(
      `approve ${approvalId}`,
    );
    socket.emit(dm("env-a3", "EvA3", { text: "approve approval_0123456789abcdef0123" }));
    await until(() => slack.posts.length === 2, "foreign approval notice");
    expect(slack.posts[1]?.text).toBe(SLACK_NOTICES.approvalForeign);
  });
});

describe("outbound", () => {
  it("chunks a long reply, records every chunk, and never sends it twice", async () => {
    const { runtime, slack } = setup();
    const { host, socket } = await openConnected(runtime, slack);
    socket.emit(dm("env-c1", "EvCh1", { text: "write a lot" }));
    await until(() => host.allThreads().length === 1, "thread");
    const threadId = host.allThreads()[0]?.thread.id ?? "";
    const paragraph = `${"word & ".repeat(300)}\n`;
    host.reply(threadId, paragraph.repeat(5));
    await until(() => host.receipts.get(`${threadId}:2`)?.state === "sent", "receipt");
    expect(slack.posts.length).toBeGreaterThan(1);
    for (const post of slack.posts) {
      expect(post.text.length).toBeLessThanOrEqual(4000);
      expect(post.text).not.toMatch(/&(?!amp;)/);
    }
    expect(host.receipts.get(`${threadId}:2`)?.ids).toEqual(slack.posts.map((post) => post.ts));
    const sent = slack.posts.length;
    await runtime.connection("conn_1")?.relay(threadId);
    expect(slack.posts).toHaveLength(sent);
  });

  it("keeps a message through a rate limit and resumes after the chunks already sent", async () => {
    const { runtime, slack } = setup();
    const { host, socket } = await openConnected(runtime, slack);
    socket.emit(dm("env-r1", "EvR1", { text: "hi" }));
    await until(() => host.allThreads().length === 1, "thread");
    const threadId = host.allThreads()[0]?.thread.id ?? "";
    // Chunk 1 goes out; chunk 2 hits four 429s (the first try and three retries), then succeeds.
    slack.script(
      "chat.postMessage",
      { status: 200, body: { ok: true, ts: "1700000200.000001" } },
      ...Array.from({ length: 4 }, () => ({
        status: 429,
        retryAfterSeconds: 1,
        body: { ok: false, error: "ratelimited" },
      })),
    );
    host.reply(threadId, `${"a".repeat(3990)}\n${"b".repeat(100)}`);
    await until(() => host.receipts.get(`${threadId}:2`)?.state === "sent", "receipt", 3000);
    const texts = slack.posts.map((post) => post.text);
    expect(texts).toEqual(["b".repeat(100)]);
    expect(host.receipts.get(`${threadId}:2`)?.ids).toEqual([
      "1700000200.000001",
      slack.posts[0]?.ts,
    ]);
  });

  it("relays nothing to a blocked person's thread", async () => {
    const { runtime, slack } = setup();
    const { host, socket } = await openConnected(runtime, slack);
    socket.emit(dm("env-k1", "EvK1", { text: "hi" }));
    await until(() => host.allThreads().length === 1, "thread");
    const threadId = host.allThreads()[0]?.thread.id ?? "";
    host.blocked.add(PERSON);
    host.reply(threadId, "you should not see this");
    await until(() => host.receipts.get(`${threadId}:2`)?.state === "blocked", "blocked receipt");
    expect(slack.posts).toEqual([]);
  });

  it("catches up on restart from the state file, through the send gate", async () => {
    const { runtime, slack } = setup();
    const { host, socket, request } = await openConnected(runtime, slack);
    socket.emit(dm("env-s1", "EvS1", { text: "hi" }));
    await until(() => host.allThreads().length === 1, "thread");
    const threadId = host.allThreads()[0]?.thread.id ?? "";
    await runtime.close("conn_1", "reconnect");
    host.reply(threadId, "sent while the plugin was down");
    await runtime.open({ ...request, reason: "restore" }, host);
    await until(() => slack.posts.length === 1, "catch-up");
    expect(slack.posts[0]?.text).toBe("sent while the plugin was down");
  });
});

describe("connection lifecycle", () => {
  it("reconnects at once on a disconnect frame and with backoff after a dropped socket", async () => {
    const { runtime, slack } = setup();
    const { socket } = await openConnected(runtime, slack);
    socket.emit({ type: "disconnect", reason: "refresh_requested" });
    await until(() => slack.sockets.length === 2, "refresh reconnect");
    expect(socket.closed).toBe(true);
    await until(() => runtime.connection("conn_1")?.status().phase === "connected", "connected");
    slack.lastSocket.drop();
    await until(() => slack.sockets.length === 3, "backoff reconnect");
    await until(() => runtime.connection("conn_1")?.status().phase === "connected", "connected");
    expect(slack.calls.filter((call) => call.method === "apps.connections.open")).toHaveLength(3);
    expect(runtime.connection("conn_1")?.status().details).toMatchObject({ reconnects: 2 });
    // Events on the new socket still arrive.
    slack.lastSocket.emit(dm("env-n1", "EvN1", { text: "still there?" }));
    await until(() => slack.lastSocket.acks.includes("env-n1"), "ack on new socket");
  });

  it("keeps retrying while Slack is unreachable", async () => {
    const { runtime, slack } = setup();
    slack.script(
      "apps.connections.open",
      { throws: true },
      { throws: true },
      { throws: true },
      { throws: true },
    );
    await runtime.open(openRequest("conn_1"), new FakeConnectionHost("conn_1"));
    await until(() => runtime.connection("conn_1")?.status().phase === "connected", "connected");
  });

  it("stops as revoked when the app is uninstalled or the token is refused", async () => {
    const { runtime, slack } = setup();
    const { host, socket } = await openConnected(runtime, slack);
    socket.emit(dm("env-t", "EvT", { text: "hi" }));
    await until(() => host.allThreads().length === 1, "thread");
    socket.emit(
      revocationEnvelope({
        envelopeId: "env-u",
        eventId: "EvU",
        install: ACME,
        type: "tokens_revoked",
      }),
    );
    await until(() => runtime.connection("conn_1")?.status().phase === "revoked", "revoked");
    expect(socket.acks).toContain("env-u");
    expect(socket.closed).toBe(true);
    const sockets = slack.sockets.length;
    // A revoked connection neither reconnects nor relays.
    host.reply(host.allThreads()[0]?.thread.id ?? "", "too late");
    await settle();
    expect(slack.sockets).toHaveLength(sockets);
    expect(slack.posts).toEqual([]);

    slack.revoke(BOT_TOKEN_2);
    await runtime.open(
      openRequest("conn_2", {
        identityKey: "slack:T0GLOBEX:A0APP2",
        secrets: { botToken: BOT_TOKEN_2, appToken: APP_TOKEN_2 },
      }),
      new FakeConnectionHost("conn_2"),
    );
    await until(() => runtime.connection("conn_2")?.status().phase === "revoked", "revoked 2");
  });

  it("refuses an app-level token of another app and a bot token of another identity", async () => {
    const { runtime, slack } = setup();
    slack.install("xoxb-acme-x", "xapp-globex-app", ACME, "A0APP2");
    await runtime.open(
      openRequest("conn_m", { secrets: { botToken: "xoxb-acme-x", appToken: "xapp-globex-app" } }),
      new FakeConnectionHost("conn_m"),
    );
    await until(() => runtime.connection("conn_m")?.status().phase === "error", "app mismatch");
    expect(runtime.connection("conn_m")?.status().message).toMatch(/different Slack app/);

    await runtime.open(
      openRequest("conn_i", { secrets: { botToken: BOT_TOKEN_2, appToken: APP_TOKEN_2 } }),
      new FakeConnectionHost("conn_i"),
    );
    await until(
      () => runtime.connection("conn_i")?.status().phase === "error",
      "identity mismatch",
    );
  });

  it("stops serving a stale host after a rebind fence", async () => {
    const { runtime, slack } = setup();
    const { host, socket } = await openConnected(runtime, slack);
    host.makeStale();
    socket.emit(dm("env-st", "EvSt", { text: "after the fence" }));
    await until(() => runtime.connection("conn_1")?.status().phase === "stopped", "stopped");
    expect(socket.acks).toContain("env-st");
  });

  it("disconnect closes the socket and removes the state file", async () => {
    const { runtime, slack } = setup();
    const { socket, request } = await openConnected(runtime, slack);
    expect(readdirSync(request.stateDirectory)).toContain(SLACK_STATE_FILE);
    await runtime.close("conn_1", "disconnect");
    expect(socket.closed).toBe(true);
    expect(readdirSync(request.stateDirectory)).not.toContain(SLACK_STATE_FILE);
    expect(await runtime.status("conn_1")).toEqual({ phase: "stopped" });
    await expect(runtime.test()).rejects.toThrow(/proactive/);
    expect(
      (
        await runtime.webhook({
          connectionId: "conn_1",
          method: "POST",
          url: "/",
          headers: {},
          body: new Uint8Array(),
        })
      ).status,
    ).toBe(404);
  });
});

describe("isolation between connections and secrets", () => {
  it("keeps two connections of one runtime separate", async () => {
    const { runtime, slack } = setup();
    const a = await openConnected(runtime, slack, "conn_a");
    const b = await openConnected(runtime, slack, "conn_b", {
      identityKey: "slack:T0GLOBEX:A0APP2",
      secrets: { botToken: BOT_TOKEN_2, appToken: APP_TOKEN_2 },
    });
    // The same DM channel id and event id in both Slack workspaces.
    a.socket.emit(dm("env-1", "EvSame", { text: "for acme" }));
    b.socket.emit(
      messageEnvelope({
        envelopeId: "env-1",
        eventId: "EvSame",
        install: GLOBEX,
        user: PERSON,
        channel: DM,
        text: "for globex",
      }),
    );
    await until(
      () => a.host.allThreads().length === 1 && b.host.allThreads().length === 1,
      "threads",
    );
    expect(a.host.receives.map((input) => input.body)).toEqual(["for acme"]);
    expect(b.host.receives.map((input) => input.body)).toEqual(["for globex"]);
    a.host.reply(a.host.allThreads()[0]?.thread.id ?? "", "acme answer");
    b.host.reply(b.host.allThreads()[0]?.thread.id ?? "", "globex answer");
    await until(() => slack.posts.length === 2, "replies");
    expect(slack.posts.map((post) => [post.token, post.text]).sort()).toEqual(
      [
        [BOT_TOKEN, "acme answer"],
        [BOT_TOKEN_2, "globex answer"],
      ].sort(),
    );
    // An event for app 2 on app 1's socket is not taken.
    a.socket.emit(
      messageEnvelope({
        envelopeId: "env-2",
        eventId: "EvCross",
        install: GLOBEX,
        user: PERSON,
        channel: DM,
        text: "cross",
      }),
    );
    await until(() => a.socket.acks.includes("env-2"), "ack");
    expect(a.host.receives).toHaveLength(1);
  });

  it("never puts a token in a log line, a status, an error or the state file", async () => {
    const { runtime, slack } = setup();
    const { host, socket, request } = await openConnected(runtime, slack);
    socket.emit(dm("env-1", "EvL1", { text: "hello" }));
    await until(() => host.allThreads().length === 1, "thread");
    host.reply(host.allThreads()[0]?.thread.id ?? "", "reply");
    slack.script(
      "chat.postMessage",
      ...Array.from({ length: 4 }, () => ({
        status: 500,
        body: { ok: false, error: "fatal_error" },
      })),
    );
    await until(() => slack.posts.length >= 1, "reply");
    socket.drop();
    await until(() => slack.sockets.length === 2, "reconnect");
    await runtime.close("conn_1", "reconnect");
    const stateFile = join(request.stateDirectory, SLACK_STATE_FILE);
    const everything = JSON.stringify({
      logs: host.logs,
      status: await runtime.connection("conn_1")?.status(),
      closedStatus: await runtime.status("conn_1"),
      state: readFileSync(stateFile, "utf8"),
    });
    expect(host.logs.length).toBeGreaterThan(0);
    for (const secret of SECRETS) expect(everything).not.toContain(secret);
    expect(everything).not.toContain("ticket=");
    expect(statSync(request.stateDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(stateFile).mode & 0o777).toBe(0o600);
  });
});
