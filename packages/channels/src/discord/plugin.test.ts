// T1 for the Discord channel plugin (ADR-0047): the whole runtime against a scripted Discord
// Gateway websocket and REST API (`test-support/fake-discord.ts`) and an in-memory
// connection-scoped host (`test-support/fake-connection-host.ts`). Nothing here talks to Discord;
// live behaviour is the "1 (live)" row of ADR-0047's Verification table and is not run.

import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BotId,
  type ChannelOpenRequest,
  type WorkspaceId,
  channelManifestV2Problems,
} from "@deskmates/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeChannelHub } from "../test-support/fake-connection-host.js";
import { FakeDiscord, type FakeDiscordBot } from "../test-support/fake-discord.js";
import { DISCORD_INTENT_DIRECT_MESSAGES } from "./gateway-session.js";
import { discordManifest } from "./manifest.js";
import {
  APPROVAL_REFUSED_NOTICE,
  EMPTY_MESSAGE_NOTICE,
  OTHER_MEDIA_NOTICE,
  imagesRefusedNotice,
} from "./notices.js";
import { channelPlugin } from "./plugin.js";
import { DiscordRuntime } from "./runtime.js";
import * as discordState from "./state.js";
import { DISCORD_STATE_FILE } from "./state.js";

const FAST = {
  reconnect: { initialMs: 5, maxMs: 20 },
  relayRetry: { initialMs: 10, maxMs: 40 },
  receiveRetryMs: [5],
  openTimeoutMs: 1_000,
  helloTimeoutMs: 500,
  invalidSessionDelayMs: () => 5,
};

const PERSON = "200000000000000001";
const OTHER_PERSON = "200000000000000002";

const directories: string[] = [];
const runtimes: DiscordRuntime[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function waitFor(
  check: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 2_000,
): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 5));
  }
}

const settle = (ms = 60) => new Promise((done) => setTimeout(done, ms));

function bot(n: number): FakeDiscordBot {
  return {
    token: `MTk-fake-token-${n}.secretpart-${n}abcdefghij`,
    userId: `10000000000000000${n}`,
    applicationId: `10000000000000000${n}`,
    username: `deskbot${n}`,
  };
}

interface Harness {
  discord: FakeDiscord;
  hub: FakeChannelHub;
  runtime: DiscordRuntime;
  contextLogs: unknown[];
  sleeps: number[];
  newRuntime(): DiscordRuntime;
  request(
    bot: FakeDiscordBot,
    overrides?: Partial<ChannelOpenRequest>,
  ): Promise<ChannelOpenRequest>;
  open(bot: FakeDiscordBot, overrides?: Partial<ChannelOpenRequest>): Promise<ChannelOpenRequest>;
}

async function harness(): Promise<Harness> {
  const discord = new FakeDiscord();
  const hub = new FakeChannelHub("discord");
  const contextLogs: unknown[] = [];
  const sleeps: number[] = [];
  const newRuntime = () => {
    const runtime = new DiscordRuntime(
      { log: (level, message, data) => contextLogs.push({ level, message, data }) },
      {
        transport: discord.transport,
        timings: FAST,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        random: () => 0.5,
      },
    );
    runtimes.push(runtime);
    return runtime;
  };
  const runtime = newRuntime();
  const requests = new Map<string, ChannelOpenRequest>();
  const request = async (b: FakeDiscordBot, overrides: Partial<ChannelOpenRequest> = {}) => {
    const existing = requests.get(b.token);
    if (existing && Object.keys(overrides).length === 0) return existing;
    const stateDirectory =
      existing?.stateDirectory ?? (await mkdtemp(join(tmpdir(), "deskmates-discord-")));
    if (!existing) directories.push(stateDirectory);
    const made: ChannelOpenRequest = {
      connectionId: `conn-${b.userId.slice(-1)}`,
      workspaceId: "ws-1" as WorkspaceId,
      botId: `bot-${b.userId.slice(-1)}` as BotId,
      identityKey: `discord:app:${b.applicationId}`,
      bindingGeneration: 1,
      credentialGeneration: 1,
      reason: "connect",
      method: "bot_token",
      config: {},
      secrets: { token: b.token },
      stateDirectory,
      ...overrides,
    };
    requests.set(b.token, made);
    return made;
  };
  return {
    discord,
    hub,
    runtime,
    contextLogs,
    sleeps,
    newRuntime,
    request,
    open: async (b, overrides = {}) => {
      const made = await request(b, overrides);
      const status = await runtime.open(made, hub.hostFor(made));
      expect(status.phase).toBe("connected");
      return made;
    },
  };
}

describe("Discord manifest and entry point", () => {
  it("declares every capability row, groups unavailable, several connections", () => {
    expect(channelManifestV2Problems(discordManifest)).toEqual([]);
    expect(discordManifest.multipleConnections).toBe(true);
    expect(discordManifest.capabilities).toMatchObject({
      directMessages: "available",
      groups: "unavailable",
      inboundImages: "available",
      inboundOtherMedia: "disabled",
      outboundReply: "available",
      proactiveMessages: "unavailable",
      testMessage: "unavailable",
    });
    expect(channelPlugin.manifest).toBe(discordManifest);
  });

  it("is listed once in the release plugin manifest at its version and ABI 2", async () => {
    const script = await readFile(
      fileURLToPath(
        new URL("../../../../scripts/write-channel-plugin-manifest.mjs", import.meta.url),
      ),
      "utf8",
    );
    const lines = script.split("\n").filter((line) => line.includes('id: "discord"'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`version: "${discordManifest.version}"`);
    expect(lines[0]).toContain("apiVersion: 2");
    expect(lines[0]).toContain('entry: "discord/plugin.js"');
  });

  it("creates the runtime only when asked", async () => {
    const runtime = await channelPlugin.create({ log: () => {} });
    expect(typeof runtime.verify).toBe("function");
    await runtime.stop();
  });
});

describe("verify (ADR-0047 decision 6)", () => {
  it("derives the identity from Discord's own answer, not the input", async () => {
    const h = await harness();
    const b = h.discord.addBot(bot(1));
    const identity = await h.runtime.verify({
      workspaceId: "ws-1" as WorkspaceId,
      method: "bot_token",
      config: { note: "discord:app:999" },
      secrets: { token: ` Bot ${b.token} ` },
    });
    expect(identity).toEqual({ identityKey: `discord:app:${b.applicationId}`, label: "deskbot1" });
    const calls = h.discord.requests.map((r) => r.url.replace(h.discord.apiBase, ""));
    expect(calls).toEqual(["/users/@me", "/applications/@me"]);
  });

  it("refuses an invalid token without echoing it", async () => {
    const h = await harness();
    const token = "MTk-not-a-real-token.zzzzzzzzzzzzzzzz";
    const error = await h.runtime
      .verify({
        workspaceId: "ws-1" as WorkspaceId,
        method: "bot_token",
        config: {},
        secrets: { token },
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Discord refused the bot token.");
    expect((error as Error).message).not.toContain(token);
  });

  it("refuses a user account's token and an unknown method", async () => {
    const h = await harness();
    const user = h.discord.addBot({ ...bot(2), bot: false });
    await expect(
      h.runtime.verify({
        workspaceId: "ws-1" as WorkspaceId,
        method: "bot_token",
        config: {},
        secrets: { token: user.token },
      }),
    ).rejects.toThrow(/not a Discord bot token/);
    await expect(
      h.runtime.verify({
        workspaceId: "ws-1" as WorkspaceId,
        method: "oauth",
        config: {},
        secrets: { token: user.token },
      }),
    ).rejects.toThrow(/Unknown Discord connection method/);
  });
});

describe("direct messages in and replies out", () => {
  it("posts a DM's text, relays the Bot's reply through the send gate", async () => {
    const h = await harness();
    const b = h.discord.addBot(bot(1));
    const request = await h.open(b);
    expect(h.discord.identifies).toEqual([
      { userId: b.userId, intents: DISCORD_INTENT_DIRECT_MESSAGES },
    ]);
    const dm = h.discord.dm(b, { userId: PERSON, username: "alex", content: "hello there" });
    await waitFor(() => h.hub.receives.length === 1, "the DM");
    expect(h.hub.receives[0]?.input).toMatchObject({
      conversationKey: dm.channel_id,
      senderId: PERSON,
      externalId: dm.id,
      body: "hello there",
      title: "Discord alex",
    });
    const [thread] = h.hub.threadsOf(request.connectionId);
    expect(thread?.conversationKey).toBe(dm.channel_id);
    h.hub.reply(thread?.id ?? "", "Hi! How can I help?");
    await waitFor(() => h.discord.sent.length === 1, "the reply");
    expect(h.discord.sent[0]).toMatchObject({
      token: b.token,
      channelId: dm.channel_id,
      content: "Hi! How can I help?",
    });
    await waitFor(() => h.hub.receipts.some((r) => r.state === "sent"), "the receipt");
    expect(h.hub.receipts).toEqual([
      {
        connectionId: request.connectionId,
        threadId: thread?.id,
        seq: 2,
        state: "sent",
        providerMessageIds: [h.discord.sent[0]?.id],
      },
    ]);
    // The person's own message is never echoed.
    expect(h.discord.sent.map((s) => s.content)).not.toContain("hello there");
  });

  it("ignores guild channels and threads, bots and system messages: no thread, no wake", async () => {
    const h = await harness();
    const b = h.discord.addBot(bot(1));
    await h.open(b);
    h.discord.dm(b, { userId: PERSON, guildId: "300000000000000001", content: "in a server" });
    h.discord.dm(b, { userId: "400000000000000001", authorBot: true, content: "beep" });
    h.discord.dm(b, { userId: b.userId, content: "my own message" });
    h.discord.dm(b, { userId: PERSON, type: 7, content: "" });
    await settle();
    expect(h.hub.receives).toEqual([]);
    expect(h.discord.sent).toEqual([]);
    expect((await h.runtime.status("conn-1")).details?.ignored).toBe(4);
  });

  it("chunks a long reply at 2000 characters and records every chunk id", async () => {
    const h = await harness();
    const b = h.discord.addBot(bot(1));
    const request = await h.open(b);
    h.discord.dm(b, { userId: PERSON, content: "write a lot" });
    await waitFor(() => h.hub.threadsOf(request.connectionId).length === 1, "the thread");
    const [thread] = h.hub.threadsOf(request.connectionId);
    const paragraph = `${"word ".repeat(300).trim()}\n`;
    h.hub.reply(thread?.id ?? "", paragraph.repeat(3));
    await waitFor(() => h.hub.receipts.length === 1, "the receipt");
    expect(h.discord.sent.length).toBeGreaterThanOrEqual(3);
    for (const sent of h.discord.sent) expect(sent.content.length).toBeLessThanOrEqual(2000);
    expect(
      h.discord.sent
        .map((s) => s.content)
        .join(" ")
        .replace(/\s+/g, " "),
    ).toBe(paragraph.repeat(3).replace(/\s+/g, " ").trim());
    expect(h.hub.receipts[0]?.providerMessageIds).toEqual(h.discord.sent.map((s) => s.id));
  });

  it("retains a permanently refused partial reply until an explicit reconnect retries its tail", async () => {
    const h = await harness();
    const b = h.discord.addBot(bot(1));
    const request = await h.open(b);
    h.discord.dm(b, { userId: PERSON, content: "go" });
    await waitFor(() => h.hub.threadsOf(request.connectionId).length === 1, "thread");
    const threadId = h.hub.threadsOf(request.connectionId)[0]?.id ?? "";
    const first = "a".repeat(1990);
    const second = "b".repeat(1990);
    h.discord.sendFailures.push({
      status: 403,
      body: { code: 50007 },
      when: (text) => text.startsWith("b"),
    });
    h.hub.reply(threadId, `${first} ${second}`);
    await waitFor(
      () => h.hub.logs.some((log) => JSON.stringify(log).includes("50007")),
      "permanent refusal",
    );
    expect((await h.runtime.status(request.connectionId)).message).toContain("partially delivered");
    await h.runtime.stop();
    const stored = JSON.parse(
      await readFile(join(request.stateDirectory, DISCORD_STATE_FILE), "utf8"),
    );
    expect(stored.threads[threadId].pending).toMatchObject({
      failed: true,
      chunkIds: [h.discord.sent[0]?.id],
    });
    const restored = h.newRuntime();
    await restored.open({ ...request, reason: "restore" }, h.hub.hostFor(request));
    expect((await restored.status(request.connectionId)).message).toContain("partially delivered");
    expect(h.hub.receipts).toHaveLength(0);
    await restored.close(request.connectionId, "reconnect");
    await restored.open({ ...request, reason: "reconnect" }, h.hub.hostFor(request));
    await waitFor(() => h.hub.receipts.length === 1, "recovered delivery");
    expect(h.discord.sent.map((sent) => sent.content)).toEqual([first, second]);
    expect(h.hub.receipts[0]?.providerMessageIds).toEqual(h.discord.sent.map((sent) => sent.id));
  });

  it("serializes overlapping reconnects of the same provider connection", async () => {
    const h = await harness();
    const b = h.discord.addBot(bot(1));
    const request = await h.open(b);
    await Promise.all([
      h.runtime.open({ ...request, reason: "reconnect" }, h.hub.hostFor(request)),
      h.runtime.open({ ...request, reason: "reconnect" }, h.hub.hostFor(request)),
    ]);
    expect(h.discord.openSockets(b)).toBe(1);
    await h.runtime.close(request.connectionId, "disconnect");
    expect(h.discord.openSockets(b)).toBe(0);
  });

  it("stops a reconnect whose persisted state is still loading", async () => {
    const h = await harness();
    const b = h.discord.addBot(bot(1));
    const request = await h.open(b);
    const load = discordState.loadDiscordState;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(discordState, "loadDiscordState").mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return load(...args);
    });
    const opening = h.runtime.open({ ...request, reason: "reconnect" }, h.hub.hostFor(request));
    await loading;
    const stopping = h.runtime.stop();
    release();
    await Promise.all([opening, stopping]);
    expect(h.discord.openSockets(b)).toBe(0);
    expect((await h.runtime.status(request.connectionId)).phase).toBe("stopped");
  });

  it("orders a second replacement behind the first state load", async () => {
    const h = await harness();
    const b = h.discord.addBot(bot(1));
    const request = await h.open(b);
    const load = discordState.loadDiscordState;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(discordState, "loadDiscordState").mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return load(...args);
    });
    const first = h.runtime.open({ ...request, reason: "reconnect" }, h.hub.hostFor(request));
    await loading;
    const second = h.runtime.open({ ...request, reason: "reconnect" }, h.hub.hostFor(request));
    release();
    await Promise.all([first, second]);
    expect(h.discord.openSockets(b)).toBe(1);
    await h.runtime.close(request.connectionId, "disconnect");
    expect(h.discord.openSockets(b)).toBe(0);
    await h.runtime.stop();
    expect(h.discord.openSockets(b)).toBe(0);
  });

  it("retries a failed chunk without resending the delivered ones, honouring 429", async () => {
    const h = await harness();
    const b = h.discord.addBot(bot(1));
    const request = await h.open(b);
    h.discord.dm(b, { userId: PERSON, content: "go" });
    await waitFor(() => h.hub.threadsOf(request.connectionId).length === 1, "the thread");
    const [thread] = h.hub.threadsOf(request.connectionId);
    const first = "a".repeat(1990);
    const second = "b".repeat(1990);
    // The first chunk goes through; the second meets a 429, then 5xx past the REST retries, so
    // the relay gives up for now and retries the thread later.
    const onSecond = (content: string) => content.startsWith("b");
    h.discord.sendFailures.push(
      { status: 429, body: { retry_after: 1.5, global: false }, when: onSecond },
      { status: 502, when: onSecond },
      { status: 502, when: onSecond },
      { status: 502, when: onSecond },
    );
    h.hub.reply(thread?.id ?? "", `${first} ${second}`);
    await waitFor(() => h.hub.receipts.length === 1, "the receipt after retry", 3_000);
    expect(h.discord.sent.map((s) => s.content)).toEqual([first, second]);
    expect(h.sleeps).toContain(1500);
    expect(h.hub.receipts[0]?.providerMessageIds).toEqual(h.discord.sent.map((s) => s.id));
  });
});

describe("images and other media (ADR-0047 decision 12)", () => {
  it("hands image bytes to the host and refuses other media with a notice", async () => {
    const h = await harness();
    const b = h.discord.addBot(bot(1));
    const request = await h.open(b);
    const png = h.discord.upload("photo.png", "image/png", new Uint8Array([137, 80, 78, 71, 1]));
    const voice = h.discord.upload("voice-message.ogg", "audio/ogg", new Uint8Array([1, 2, 3]));
    const dm = h.discord.dm(b, { userId: PERSON, content: "look", attachments: [png, voice] });
    await waitFor(() => h.hub.images.length === 1, "the image");
    expect(h.hub.images[0]).toMatchObject({
      connectionId: request.connectionId,
      name: "photo.png",
      mimeType: "image/png",
      bytes: 5,
    });
    const posted = h.hub.receives.find((r) => r.input.body === "look");
    expect(posted?.input.images).toHaveLength(1);
    await waitFor(() => h.discord.sent.length === 1, "the notice");
    expect(h.discord.sent[0]).toMatchObject({ content: OTHER_MEDIA_NOTICE, replyTo: dm.id });
    // The CDN download carries no token.
    const cdn = h.discord.requests.filter((r) => r.url.startsWith("https://cdn.discordapp.com/"));
    expect(cdn).toHaveLength(1);
    expect(cdn[0]?.authorization).toBeUndefined();
  });

  it("refuses an oversized image and an image-less sticker with notices, posting nothing", async () => {
    const h = await harness();
    const b = h.discord.addBot(bot(1));
    const request = await h.open(b);
    const big = h.discord.upload("big.jpg", "image/jpeg", new Uint8Array(4));
    big.size = 11 * 1024 * 1024;
    h.discord.dm(b, { userId: PERSON, attachments: [big] });
    await waitFor(() => h.discord.sent.length === 1, "the image notice");
    expect(h.discord.sent[0]?.content).toBe(imagesRefusedNotice(1));
    h.discord.dm(b, { userId: PERSON, stickers: 1 });
    await waitFor(() => h.discord.sent.length === 2, "the sticker notice");
    expect(h.discord.sent[1]?.content).toBe(OTHER_MEDIA_NOTICE);
    h.discord.dm(b, { userId: PERSON, content: "   " });
    await waitFor(() => h.discord.sent.length === 3, "the empty notice");
    expect(h.discord.sent[2]?.content).toBe(EMPTY_MESSAGE_NOTICE);
    expect(h.hub.threadsOf(request.connectionId)).toEqual([]);
    expect(h.discord.requests.some((r) => r.url.includes("big.jpg"))).toBe(false);
  });
});

describe("sender blocklist (ADR-0047 decision 13)", () => {
  it("drops a blocked sender's text, image and media silently, and sends them nothing", async () => {
    const h = await harness();
    const b = h.discord.addBot(bot(1));
    const request = await h.open(b);
    h.hub.block(request.connectionId, PERSON);
    const png = h.discord.upload("photo.png", "image/png", new Uint8Array([1, 2]));
    h.discord.dm(b, { userId: PERSON, content: "hello" });
    h.discord.dm(b, { userId: PERSON, attachments: [png] });
    h.discord.dm(b, { userId: PERSON, stickers: 1 });
    h.discord.dm(b, {
      userId: PERSON,
      content: "approve 123e4567-e89b-12d3-a456-426614174000",
    });
    await waitFor(() => h.hub.receives.length >= 4, "the admission checks");
    await settle();
    expect(h.hub.threadsOf(request.connectionId)).toEqual([]);
    expect(h.discord.sent).toEqual([]);
    expect(h.discord.requests.some((r) => r.url.includes("photo.png"))).toBe(false);
    // Another person on the same bot is admitted (allow by default).
    h.discord.dm(b, { userId: OTHER_PERSON, content: "hi" });
    await waitFor(() => h.hub.threadsOf(request.connectionId).length === 1, "the other DM");
  });
});

describe("approvals from Discord (ADR-0017 decision 7)", () => {
  it("relays the request with the grammar, decides on a reply, never posts the command", async () => {
    const h = await harness();
    const b = h.discord.addBot(bot(1));
    const request = await h.open(b);
    h.discord.dm(b, { userId: PERSON, content: "send the mail" });
    await waitFor(() => h.hub.threadsOf(request.connectionId).length === 1, "the thread");
    const [thread] = h.hub.threadsOf(request.connectionId);
    const approvalId = "123e4567-e89b-12d3-a456-426614174000";
    h.hub.requestApproval(thread?.id ?? "", approvalId);
    await waitFor(() => h.discord.sent.length === 1, "the request");
    expect(h.discord.sent[0]?.content).toContain(`Reply "approve ${approvalId}"`);
    h.discord.dm(b, { userId: PERSON, content: `approve ${approvalId}` });
    await waitFor(() => h.hub.decisions.length === 1, "the decision");
    expect(h.hub.decisions[0]).toEqual({
      id: approvalId,
      decision: "allow_once",
      authorId: `discord:${PERSON}`,
    });
    expect(h.hub.messages(thread?.id ?? "").map((m) => m.body)).not.toContain(
      `approve ${approvalId}`,
    );
    // Someone else's approval id from another conversation is refused with a notice.
    h.discord.dm(b, { userId: OTHER_PERSON, content: "hello" });
    await waitFor(() => h.hub.threadsOf(request.connectionId).length === 2, "second thread");
    h.discord.dm(b, { userId: OTHER_PERSON, content: `deny ${approvalId} no` });
    await waitFor(
      () => h.discord.sent.some((s) => s.content === APPROVAL_REFUSED_NOTICE),
      "the refusal",
    );
    expect(h.hub.decisions).toHaveLength(1);
  });
});

describe("heartbeat, reconnect and resume", () => {
  it("heartbeats, resumes after a drop and receives what Discord replays", async () => {
    const h = await harness();
    const b = h.discord.addBot(bot(1));
    const request = await h.open(b);
    await waitFor(() => h.discord.heartbeats.length >= 2, "heartbeats");
    h.discord.drop(b, 1006);
    // Sent while the socket is down: buffered by Discord and replayed on resume.
    h.discord.dm(b, { userId: PERSON, content: "while you were away" });
    await waitFor(() => h.discord.resumes.length === 1, "the resume");
    expect(h.discord.resumes[0]).toEqual({ userId: b.userId, ok: true });
    expect(h.discord.connects.at(-1)).toBe(`${h.discord.resumeUrl}/?v=10&encoding=json`);
    await waitFor(() => h.hub.threadsOf(request.connectionId).length === 1, "the replayed DM");
    expect(h.discord.identifies).toHaveLength(1);
    expect((await h.runtime.status(request.connectionId)).phase).toBe("connected");
  });

  it("resumes on opcode 7 and re-identifies after an invalid session", async () => {
    const h = await harness();
    const b = h.discord.addBot(bot(1));
    await h.open(b);
    h.discord.requestReconnect(b);
    await waitFor(() => h.discord.resumes.length === 1, "the resume after op 7");
    h.discord.expireSessions(b);
    await waitFor(() => h.discord.resumes.length === 2, "the failed resume");
    expect(h.discord.resumes[1]?.ok).toBe(false);
    await waitFor(() => h.discord.identifies.length === 2, "a fresh identify");
  });

  it("treats a missing heartbeat ACK as a zombie connection and resumes", async () => {
    const h = await harness();
    const b = h.discord.addBot(bot(1));
    await h.open(b);
    h.discord.ackHeartbeats = false;
    await waitFor(() => h.discord.resumes.length >= 1, "the zombie resume");
    h.discord.ackHeartbeats = true;
    await waitFor(() => h.discord.openSockets(b) === 1, "one open socket");
  });

  it("keeps the session across a Gateway restart and resumes from the saved state", async () => {
    const h = await harness();
    const b = h.discord.addBot(bot(1));
    const request = await h.open(b);
    h.discord.dm(b, { userId: PERSON, content: "first" });
    await waitFor(() => h.hub.threadsOf(request.connectionId).length === 1, "the first DM");
    await h.runtime.stop();
    const file = join(request.stateDirectory, DISCORD_STATE_FILE);
    expect((await stat(request.stateDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const saved = await readFile(file, "utf8");
    expect(saved).not.toContain(b.token);
    expect(JSON.parse(saved).resume.sessionId).toMatch(/^session-/);
    h.discord.dm(b, { userId: PERSON, content: "during the restart" });
    const restarted = h.newRuntime();
    const restore = { ...request, reason: "restore" as const };
    const status = await restarted.open(restore, h.hub.hostFor(restore));
    expect(status.phase).toBe("connected");
    expect(h.discord.resumes).toEqual([{ userId: b.userId, ok: true }]);
    await waitFor(
      () => h.hub.receives.some((r) => r.input.body === "during the restart"),
      "the replayed DM",
    );
    expect(h.hub.threadsOf(request.connectionId)).toHaveLength(1);
    expect(h.hub.messages(h.hub.threadsOf(request.connectionId)[0]?.id ?? "")).toHaveLength(2);
  });

  it("reads missed DMs over REST when a restart cannot resume", async () => {
    const h = await harness();
    const b = h.discord.addBot(bot(1));
    const request = await h.open(b);
    h.discord.dm(b, { userId: PERSON, content: "first" });
    await waitFor(() => h.hub.threadsOf(request.connectionId).length === 1, "the first DM");
    await settle();
    await h.runtime.stop();
    h.discord.dm(b, { userId: PERSON, content: "missed one" });
    h.discord.expireSessions(b);
    const restarted = h.newRuntime();
    const restore = { ...request, reason: "restore" as const };
    await restarted.open(restore, h.hub.hostFor(restore));
    await waitFor(
      () => h.hub.receives.some((r) => r.input.body === "missed one"),
      "the caught-up DM",
    );
    expect(h.discord.identifies).toHaveLength(2);
    // "first" was not posted twice.
    const thread = h.hub.threadsOf(request.connectionId)[0];
    expect(h.hub.messages(thread?.id ?? "").map((m) => m.body)).toEqual(["first", "missed one"]);
  });
});

describe("credentials and lifecycle", () => {
  it("reports revoked for a refused token and stops reconnecting", async () => {
    const h = await harness();
    const b = h.discord.addBot(bot(1));
    const request = await h.open(b);
    h.discord.revoke(b.token);
    await waitFor(phaseIs(h, request.connectionId, "revoked"), "revoked");
    const connects = h.discord.connects.length;
    await settle(100);
    expect(h.discord.connects.length).toBe(connects);
    const status = await h.runtime.status(request.connectionId);
    expect(status.message).toBe("Discord refused the bot token.");
  });

  it("opens as revoked when the token is already invalid", async () => {
    const h = await harness();
    const b = h.discord.addBot(bot(1));
    h.discord.revoke(b.token);
    const request = await h.request(b);
    const status = await h.runtime.open(request, h.hub.hostFor(request));
    expect(status.phase).toBe("revoked");
  });

  it("refuses to run when the token now belongs to another application", async () => {
    const h = await harness();
    const b = h.discord.addBot(bot(1));
    const request = await h.request(b, { identityKey: "discord:app:999999999999999999" });
    const status = await h.runtime.open(request, h.hub.hostFor(request));
    expect(status.phase).toBe("failed");
  });

  it("disconnect ends the Discord session and leaves nothing behind", async () => {
    const h = await harness();
    const b = h.discord.addBot(bot(1));
    const request = await h.open(b);
    h.discord.dm(b, { userId: PERSON, content: "hi" });
    await waitFor(() => h.hub.threadsOf(request.connectionId).length === 1, "the DM");
    await h.runtime.close(request.connectionId, "disconnect");
    h.hub.revoke(request.connectionId);
    expect(h.discord.clientCloses.at(-1)).toBe(1000);
    await rm(request.stateDirectory, { recursive: true, force: true });
    await settle();
    await expect(readdir(request.stateDirectory)).rejects.toThrow();
    expect((await h.runtime.status(request.connectionId)).phase).toBe("stopped");
    h.discord.dm(b, { userId: PERSON, content: "after disconnect" });
    await settle();
    expect(h.hub.receives.map((r) => r.input.body)).not.toContain("after disconnect");
  });

  it("serves only the new host after a rebind; the old generation's threads are not relayed", async () => {
    const h = await harness();
    const b = h.discord.addBot(bot(1));
    const request = await h.open(b);
    h.discord.dm(b, { userId: PERSON, content: "to the first bot" });
    await waitFor(() => h.hub.threadsOf(request.connectionId).length === 1, "the first thread");
    const [old] = h.hub.threadsOf(request.connectionId);
    await h.runtime.close(request.connectionId, "rebind");
    h.hub.revoke(request.connectionId);
    const rebound = await h.request(b, {
      bindingGeneration: 2,
      botId: "bot-other" as BotId,
      reason: "rebind",
    });
    const status = await h.runtime.open(rebound, h.hub.hostFor(rebound));
    expect(status.phase).toBe("connected");
    h.hub.reply(old?.id ?? "", "late reply of the old bot");
    h.discord.dm(b, { userId: PERSON, content: "to the second bot" });
    await waitFor(() => h.hub.threadsOf(request.connectionId).length === 2, "the new thread");
    const fresh = h.hub.threadsOf(request.connectionId).find((t) => t.bindingGeneration === 2);
    expect(fresh?.conversationKey).toBe(old?.conversationKey);
    await settle();
    expect(h.discord.sent.map((s) => s.content)).not.toContain("late reply of the old bot");
  });

  it("keeps two connections with different bots apart", async () => {
    const h = await harness();
    const one = h.discord.addBot(bot(1));
    const two = h.discord.addBot(bot(2));
    const a = await h.open(one);
    const b = await h.open(two);
    h.discord.dm(one, { userId: PERSON, content: "to one" });
    h.discord.dm(two, { userId: PERSON, content: "to two" });
    await waitFor(() => h.hub.receives.length === 2, "both DMs");
    expect(h.hub.receives.map((r) => [r.connectionId, r.input.body]).sort()).toEqual([
      [a.connectionId, "to one"],
      [b.connectionId, "to two"],
    ]);
    const [threadA] = h.hub.threadsOf(a.connectionId);
    const [threadB] = h.hub.threadsOf(b.connectionId);
    expect(threadA?.conversationKey).not.toBe(threadB?.conversationKey);
    h.hub.reply(threadA?.id ?? "", "reply from one");
    h.hub.reply(threadB?.id ?? "", "reply from two");
    await waitFor(() => h.discord.sent.length === 2, "both replies");
    const byToken = Object.fromEntries(h.discord.sent.map((s) => [s.content, s.token]));
    expect(byToken).toEqual({ "reply from one": one.token, "reply from two": two.token });
    await h.runtime.close(a.connectionId, "disconnect");
    h.discord.dm(two, { userId: PERSON, content: "still here" });
    await waitFor(
      () => h.hub.receives.some((r) => r.input.body === "still here"),
      "the second bot still works",
    );
  });

  it("never writes the token into logs, statuses, host input or state", async () => {
    const h = await harness();
    const b = h.discord.addBot(bot(1));
    const request = await h.open(b);
    h.discord.dm(b, { userId: PERSON, content: "hi" });
    await waitFor(() => h.hub.threadsOf(request.connectionId).length === 1, "the DM");
    const [thread] = h.hub.threadsOf(request.connectionId);
    h.discord.sendFailures.push({ status: 403, body: { code: 50007, message: "Cannot send" } });
    h.hub.reply(thread?.id ?? "", "this one is refused");
    await settle();
    h.discord.drop(b);
    await waitFor(() => h.discord.resumes.length === 1, "a resume");
    h.discord.revoke(b.token);
    await waitFor(phaseIs(h, request.connectionId, "revoked"), "revoked");
    await h.runtime.stop();
    const state = await readFile(join(request.stateDirectory, DISCORD_STATE_FILE), "utf8");
    const everything = JSON.stringify({
      logs: h.hub.logs,
      context: h.contextLogs,
      receives: h.hub.receives,
      status: await h.runtime.status(request.connectionId),
      state,
    });
    expect(everything).not.toContain(b.token);
    expect(everything).not.toContain(b.token.split(".")[1]);
    expect(h.hub.logs.some((l) => l.message.includes("refused a send"))).toBe(true);
    // The token travelled only in the REST Authorization header.
    for (const r of h.discord.requests) expect(r.url).not.toContain(b.token);
  });
});

function phaseIs(h: Harness, connectionId: string, phase: string): () => Promise<boolean> {
  return async () => (await h.runtime.status(connectionId)).phase === phase;
}
