// T1, ADR-0047 for Telegram: the plugin's runtime against a scripted Bot API (`FakeTelegram`) and
// an in-memory connection host (`FakeConnectionGateway`). Covers verify, inbound text and images,
// ignored groups and topics, the blocklist, chunked replies through the send gate, offset and
// cursor persistence across a restart, a revoked token, two bots kept apart, approvals, and that
// the token never reaches a log line, a status, a host call or the state file. Nothing here is
// evidence of live Telegram behaviour.

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APPROVAL_ATTACHMENT_MIME,
  type ChannelOpenRequest,
  type ChannelPluginRuntimeV2,
  type WorkspaceId,
  channelManifestV2Problems,
} from "@deskmates/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeConnectionGateway } from "../test-support/fake-telegram-connection-host.js";
import { FakeTelegram } from "../test-support/fake-telegram.js";
import {
  APPROVAL_REFUSED_NOTICE,
  CONTINUITY_HELP,
  OTHER_MEDIA_NOTICE,
  REVOKED_MESSAGE,
  imagesRefusedNotice,
} from "./connection.js";
import { TELEGRAM_COMMANDS } from "./menu.js";
import { TELEGRAM_MANIFEST, createTelegramPlugin } from "./plugin.js";
import { TELEGRAM_STATE_FILE } from "./state.js";

// The token's numeric prefix deliberately differs from the bot id `getMe` returns: the identity
// must come from the provider's answer, never from what the operator pasted.
const TOKEN_A = "777:AAfake-token-alpha-never-public-0001";
const TOKEN_A_ROTATED = "777:AAfake-token-alpha-rotated-never-public-02";
const TOKEN_B = "888:AAfake-token-bravo-never-public-0003";
const BOT_A = { token: TOKEN_A, id: 5001, username: "alpha_bot" };
const BOT_B = { token: TOKEN_B, id: 6002, username: "bravo_bot" };
const PERSON = 42;
const OTHER_PERSON = 43;

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);

interface Running {
  runtime: ChannelPluginRuntimeV2;
  gateway: FakeConnectionGateway;
  request: ChannelOpenRequest;
  contextLogs: unknown[];
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "telegram-plugin-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function waitFor(check: () => boolean, label: string, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await new Promise((done) => setTimeout(done, 5));
  }
}

async function runtimeFor(fake: FakeTelegram, contextLogs: unknown[] = []) {
  const plugin = createTelegramPlugin({
    transport: fake.transport,
    retry: { initialMs: 5, maxMs: 20 },
    pollTimeoutSeconds: 1,
  });
  const runtime = await plugin.create({
    log: (level, message, data) => contextLogs.push({ level, message, data }),
  });
  cleanups.push(() => runtime.stop());
  return runtime;
}

async function open(
  fake: FakeTelegram,
  options: {
    token: string;
    identityKey: string;
    connectionId?: string;
    botId?: string;
    directory?: string;
    gateway?: FakeConnectionGateway;
    runtime?: ChannelPluginRuntimeV2;
    bindingGeneration?: number;
    credentialGeneration?: number;
    reason?: ChannelOpenRequest["reason"];
  },
): Promise<Running> {
  const contextLogs: unknown[] = [];
  const runtime = options.runtime ?? (await runtimeFor(fake, contextLogs));
  const connectionId = options.connectionId ?? "conn-a";
  const gateway =
    options.gateway ?? new FakeConnectionGateway(connectionId, "ws-1", options.botId ?? "bot-a");
  if (options.bindingGeneration) gateway.bindingGeneration = options.bindingGeneration;
  const request: ChannelOpenRequest = {
    connectionId,
    workspaceId: "ws-1" as WorkspaceId,
    botId: gateway.botId as ChannelOpenRequest["botId"],
    identityKey: options.identityKey,
    bindingGeneration: gateway.bindingGeneration,
    credentialGeneration: options.credentialGeneration ?? 1,
    reason: options.reason ?? "connect",
    method: "token",
    config: {},
    secrets: { token: options.token },
    stateDirectory: options.directory ?? stateDir(),
  };
  const status = await runtime.open(request, gateway.issue());
  expect(status.phase).not.toBe("degraded");
  return { runtime, gateway, request, contextLogs };
}

function fakeWithBots(): FakeTelegram {
  const fake = new FakeTelegram();
  fake.addBot(BOT_A);
  fake.addBot(BOT_B);
  return fake;
}

describe("Telegram plugin manifest (ADR-0047 decision 12)", () => {
  it("is a loadable ABI-2 manifest with groups unavailable and several connections", () => {
    expect(channelManifestV2Problems(TELEGRAM_MANIFEST)).toEqual([]);
    expect(TELEGRAM_MANIFEST).toMatchObject({
      id: "telegram",
      multipleConnections: true,
      capabilities: {
        directMessages: "available",
        groups: "unavailable",
        inboundImages: "available",
        inboundOtherMedia: "disabled",
        outboundReply: "available",
        proactiveMessages: "unavailable",
        streaming: "disabled",
        approvals: "available",
        testMessage: "unavailable",
      },
    });
    const field = TELEGRAM_MANIFEST.methods[0]?.fields.find((f) => f.key === "token");
    expect(field).toMatchObject({ secret: true, required: true, kind: "password" });
  });
});

describe("Telegram verify (ADR-0047 decision 6)", () => {
  it("derives the identity from getMe, not from the pasted token", async () => {
    const fake = fakeWithBots();
    const runtime = await runtimeFor(fake);
    const identity = await runtime.verify({
      workspaceId: "ws-1" as WorkspaceId,
      method: "token",
      config: {},
      secrets: { token: TOKEN_A },
    });
    expect(identity).toEqual({ identityKey: "telegram:bot:5001", label: "@alpha_bot" });
    // A rotated token of the same bot verifies to the same identity (a relink).
    fake.addBot({ ...BOT_A, token: TOKEN_A_ROTATED });
    await expect(
      runtime.verify({
        workspaceId: "ws-1" as WorkspaceId,
        method: "token",
        config: {},
        secrets: { token: TOKEN_A_ROTATED },
      }),
    ).resolves.toMatchObject({ identityKey: "telegram:bot:5001" });
  });

  it("refuses an unknown or malformed token without echoing it", async () => {
    const fake = fakeWithBots();
    const runtime = await runtimeFor(fake);
    const unknown = "999:AAunknown-token-never-public-000000";
    const error = await runtime
      .verify({
        workspaceId: "ws-1" as WorkspaceId,
        method: "token",
        config: {},
        secrets: { token: unknown },
      })
      .catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain("AAunknown");
    const calls = fake.calls.length;
    await expect(
      runtime.verify({
        workspaceId: "ws-1" as WorkspaceId,
        method: "token",
        config: {},
        secrets: { token: "../../evil?x=1" },
      }),
    ).rejects.toThrow(/not a Telegram bot token/);
    expect(fake.calls.length).toBe(calls);
  });
});

describe("Telegram inbound (ADR-0047 decisions 11 to 13)", () => {
  it("posts a private text message and relays the Bot's reply through the send gate", async () => {
    const fake = fakeWithBots();
    const { gateway } = await open(fake, { token: TOKEN_A, identityKey: "telegram:bot:5001" });
    const update = fake.privateText(TOKEN_A, PERSON, "hello there");
    await waitFor(() => gateway.threads.size === 1 && fake.pending(TOKEN_A) === 0, "posted");
    const [thread] = [...gateway.threads.values()];
    expect(thread?.conversationKey).toBe(String(PERSON));
    expect(thread?.messages[0]).toMatchObject({
      authorKind: "human",
      authorId: `telegram:${PERSON}`,
      body: "hello there",
      externalId: `${PERSON}:${update.message?.message_id}`,
    });
    // The person's own message is never echoed back.
    expect(fake.sends).toEqual([]);

    const reply = gateway.append(thread?.thread.id ?? "", { body: "Hi! *Not* markdown." });
    await waitFor(() => fake.sends.length === 1, "reply sent");
    expect(fake.sends[0]).toMatchObject({
      botId: 5001,
      chatId: String(PERSON),
      text: "Hi! *Not* markdown.",
    });
    const sendCall = fake.calls.find((c) => c.method === "sendMessage");
    expect(sendCall?.params.parse_mode).toBeUndefined();
    await waitFor(() => gateway.receipts.has(`${reply.threadId}:${reply.seq}`), "receipt");
    expect(gateway.receipts.get(`${reply.threadId}:${reply.seq}`)).toEqual({
      state: "sent",
      ids: [String(fake.sends[0]?.messageId)],
    });
  });

  it("receives the largest photo size and image documents as uploads; refuses the rest with a notice", async () => {
    const fake = fakeWithBots();
    const { gateway } = await open(fake, { token: TOKEN_A, identityKey: "telegram:bot:5001" });
    const small = fake.addFile(new Uint8Array([0xff, 0xd8, 0xff, 0x00]));
    const large = fake.addFile(JPEG);
    fake.push(TOKEN_A, {
      from: { id: PERSON, is_bot: false },
      chat: { id: PERSON, type: "private" },
      caption: "look",
      photo: [
        { file_id: small, width: 90, height: 60 },
        { file_id: large, width: 1280, height: 853 },
      ],
    });
    await waitFor(() => gateway.storedImages.length === 1, "photo stored");
    expect(gateway.storedImages[0]).toMatchObject({ mimeType: "image/jpeg" });
    expect(gateway.storedImages[0]?.bytes).toEqual(JPEG);
    const [thread] = [...gateway.threads.values()];
    expect(thread?.messages[0]?.body).toBe("look");
    expect(thread?.messages[0]?.attachments).toHaveLength(1);
    expect(fake.calls.filter((c) => c.method === "getFile").map((c) => c.params.file_id)).toEqual([
      large,
    ]);

    // An image document whose bytes are PNG is stored as PNG, whatever its claimed type.
    const doc = fake.addFile(PNG);
    fake.push(TOKEN_A, {
      from: { id: PERSON, is_bot: false },
      chat: { id: PERSON, type: "private" },
      document: { file_id: doc, file_name: "shot.jpg", mime_type: "image/jpeg" },
    });
    await waitFor(() => gateway.storedImages.length === 2, "document stored");
    expect(gateway.storedImages[1]?.mimeType).toBe("image/png");

    // Too large by Telegram's own size: not downloaded, a notice instead, nothing posted.
    const huge = fake.addFile(JPEG, { size: 11 * 1024 * 1024 });
    const before = thread?.messages.length ?? 0;
    fake.push(TOKEN_A, {
      from: { id: PERSON, is_bot: false },
      chat: { id: PERSON, type: "private" },
      photo: [{ file_id: huge, width: 9000, height: 9000, file_size: 11 * 1024 * 1024 }],
    });
    await waitFor(() => fake.sends.some((s) => s.text === imagesRefusedNotice(1)), "size notice");
    expect(thread?.messages.length).toBe(before);
    expect(fake.calls.filter((c) => c.params.file_id === huge)).toEqual([]);

    // Bytes that are not an image are refused.
    const fakeImage = fake.addFile(new TextEncoder().encode("not an image"));
    fake.push(TOKEN_A, {
      from: { id: PERSON, is_bot: false },
      chat: { id: PERSON, type: "private" },
      document: { file_id: fakeImage, file_name: "x.png", mime_type: "image/png" },
    });
    await waitFor(
      () => fake.sends.filter((s) => s.text === imagesRefusedNotice(1)).length === 2,
      "sniff notice",
    );
    expect(gateway.storedImages).toHaveLength(2);
  });

  it("refuses voice, video, stickers and other files with a notice; a caption still posts", async () => {
    const fake = fakeWithBots();
    const { gateway } = await open(fake, { token: TOKEN_A, identityKey: "telegram:bot:5001" });
    fake.push(TOKEN_A, {
      from: { id: PERSON, is_bot: false },
      chat: { id: PERSON, type: "private" },
      voice: { file_id: "v1", duration: 3 },
    });
    await waitFor(() => fake.sends.length === 1, "voice notice");
    expect(fake.sends[0]?.text).toBe(OTHER_MEDIA_NOTICE);
    expect(gateway.threads.size).toBe(0);

    fake.push(TOKEN_A, {
      from: { id: PERSON, is_bot: false },
      chat: { id: PERSON, type: "private" },
      caption: "the report",
      document: { file_id: "d1", file_name: "report.pdf", mime_type: "application/pdf" },
    });
    await waitFor(() => fake.sends.length === 2, "document notice");
    expect(fake.sends[1]?.text).toBe(OTHER_MEDIA_NOTICE);
    const [thread] = [...gateway.threads.values()];
    expect(thread?.messages.map((m) => m.body)).toEqual(["the report"]);
    expect(fake.calls.filter((c) => c.method === "getFile")).toEqual([]);
  });

  it("ignores groups, supergroups, channels and topic messages: no thread, no reply", async () => {
    const fake = fakeWithBots();
    const { gateway } = await open(fake, { token: TOKEN_A, identityKey: "telegram:bot:5001" });
    for (const type of ["group", "supergroup", "channel"])
      fake.push(TOKEN_A, {
        from: { id: PERSON, is_bot: false },
        chat: { id: -100123, type },
        text: "@alpha_bot hello group",
      });
    fake.privateText(TOKEN_A, PERSON, "in a topic", {
      is_topic_message: true,
      message_thread_id: 7,
    });
    fake.push(TOKEN_A, {
      from: { id: 9, is_bot: true },
      chat: { id: 9, type: "private" },
      text: "from a bot",
    });
    await waitFor(
      () => fake.pending(TOKEN_A) === 0 && fake.offsets(TOKEN_A).length >= 2,
      "drained",
    );
    expect(gateway.receiveCalls).toEqual([]);
    expect(gateway.threads.size).toBe(0);
    expect(fake.sends).toEqual([]);
  });

  it("drops a blocklisted sender's messages and sends that sender nothing (decision 13)", async () => {
    const fake = fakeWithBots();
    const { gateway } = await open(fake, { token: TOKEN_A, identityKey: "telegram:bot:5001" });
    fake.privateText(TOKEN_A, PERSON, "before the block");
    await waitFor(() => gateway.threads.size === 1, "first message");
    const [thread] = [...gateway.threads.values()];
    gateway.blocked.add(String(PERSON));

    fake.privateText(TOKEN_A, PERSON, "after the block");
    fake.push(TOKEN_A, {
      from: { id: PERSON, is_bot: false },
      chat: { id: PERSON, type: "private" },
      sticker: { file_id: "s1" },
    });
    fake.privateText(TOKEN_A, PERSON, "approve 123e4567-e89b-12d3-a456-426614174000");
    // A reply the Bot had already written is not sent either (the gate answers `blocked`).
    const reply = gateway.append(thread?.thread.id ?? "", { body: "late reply" });
    await waitFor(() => fake.pending(TOKEN_A) === 0, "drained");
    await waitFor(() => gateway.receipts.has(`${reply.threadId}:${reply.seq}`), "gate");
    expect(gateway.receipts.get(`${reply.threadId}:${reply.seq}`)?.state).toBe("blocked");
    expect(thread?.messages.map((m) => m.body)).toEqual(["before the block", "late reply"]);
    expect(gateway.threads.size).toBe(1);
    expect(fake.sends).toEqual([]);
    expect(gateway.decisions).toEqual([]);

    // Another person on the same bot is unaffected (allow by default).
    fake.privateText(TOKEN_A, OTHER_PERSON, "hi");
    await waitFor(() => gateway.threads.size === 2, "other person admitted");
  });
});

describe("Telegram outbound", () => {
  it("chunks a long reply at Telegram's limit and resumes after a 429 without repeating a chunk", async () => {
    const fake = fakeWithBots();
    const { gateway } = await open(fake, { token: TOKEN_A, identityKey: "telegram:bot:5001" });
    fake.privateText(TOKEN_A, PERSON, "write a lot");
    await waitFor(() => gateway.threads.size === 1, "thread");
    const [thread] = [...gateway.threads.values()];
    const paragraph = `${"word ".repeat(700).trim()}\n`;
    const body = paragraph.repeat(3);
    expect(body.length).toBeGreaterThan(4096 * 2);
    fake.sendFailures.push({ error_code: 429, description: "Too Many Requests", retry_after: 0 });
    const reply = gateway.append(thread?.thread.id ?? "", { body });
    await waitFor(
      () => gateway.receipts.get(`${reply.threadId}:${reply.seq}`) !== undefined,
      "sent",
    );
    const texts = fake.sends.map((s) => s.text);
    expect(texts.length).toBeGreaterThanOrEqual(3);
    for (const text of texts) expect(text.length).toBeLessThanOrEqual(4096);
    expect(texts.join("\n").replace(/\s+/g, " ").trim()).toBe(body.replace(/\s+/g, " ").trim());
    expect(gateway.receipts.get(`${reply.threadId}:${reply.seq}`)?.ids).toEqual(
      fake.sends.map((s) => String(s.messageId)),
    );
  });

  it("relays approval requests with the decision grammar and decides from the person's reply", async () => {
    const fake = fakeWithBots();
    const { gateway } = await open(fake, { token: TOKEN_A, identityKey: "telegram:bot:5001" });
    fake.privateText(TOKEN_A, PERSON, "please send the e-mail");
    await waitFor(() => gateway.threads.size === 1, "thread");
    const [thread] = [...gateway.threads.values()];
    const approvalId = "123e4567-e89b-12d3-a456-426614174000";
    gateway.addApproval(approvalId, thread?.thread.id ?? "");
    gateway.append(thread?.thread.id ?? "", {
      authorKind: "system",
      body: "Approval needed: send an e-mail.",
      attachments: [{ name: "approval", mimeType: APPROVAL_ATTACHMENT_MIME, ref: approvalId }],
    });
    await waitFor(() => fake.sends.length === 1, "approval relayed");
    expect(fake.sends[0]?.text).toContain(`approve ${approvalId}`);

    fake.privateText(TOKEN_A, PERSON, `approve ${approvalId}`);
    await waitFor(() => gateway.decisions.length === 1, "decided");
    expect(gateway.decisions[0]).toEqual({
      id: approvalId,
      decision: "allow_once",
      senderId: String(PERSON),
    });
    // The command is a decision, not a message.
    expect(thread?.messages.some((m) => m.body.startsWith("approve "))).toBe(false);

    // An approval of no thread of this connection is refused with a notice.
    fake.privateText(TOKEN_A, PERSON, "deny 99999999-e89b-12d3-a456-426614174000 no");
    await waitFor(() => fake.sends.some((s) => s.text === APPROVAL_REFUSED_NOTICE), "refused");
    expect(gateway.decisions).toHaveLength(1);
  });
});

describe("Telegram restart, revoke and separation (ADR-0047 decisions 8, 9, 11, 14)", () => {
  it("persists the update offset and relay cursors across a restart", async () => {
    const fake = fakeWithBots();
    const directory = stateDir();
    const first = await open(fake, {
      token: TOKEN_A,
      identityKey: "telegram:bot:5001",
      directory,
    });
    const u1 = fake.privateText(TOKEN_A, PERSON, "one");
    const u2 = fake.privateText(TOKEN_A, PERSON, "two");
    await waitFor(() => first.gateway.threads.values().next().value?.messages.length === 2, "two");
    const [thread] = [...first.gateway.threads.values()];
    first.gateway.append(thread?.thread.id ?? "", { body: "reply one" });
    await waitFor(() => fake.sends.length === 1, "first reply");
    await waitFor(() => {
      const saved = JSON.parse(readFileSync(join(directory, TELEGRAM_STATE_FILE), "utf8"));
      return saved.offset === u2.update_id + 1;
    }, "offset saved");
    await first.runtime.stop();

    // While the Gateway restarts, the Bot writes another reply.
    first.gateway.revoke();
    first.gateway.append(thread?.thread.id ?? "", { body: "reply two" });
    const second = await open(fake, {
      token: TOKEN_A,
      identityKey: "telegram:bot:5001",
      directory,
      gateway: first.gateway,
      reason: "restore",
    });
    await waitFor(() => fake.sends.length === 2, "second reply after restore");
    expect(fake.sends.map((s) => s.text)).toEqual(["reply one", "reply two"]);
    // The first poll after the restart confirms everything handled before it.
    const offsets = fake.offsets(TOKEN_A);
    expect(offsets.at(-1)).toBe(u2.update_id + 1);
    expect(offsets).not.toContain(u1.update_id);
    fake.privateText(TOKEN_A, PERSON, "three");
    await waitFor(() => thread?.messages.some((m) => m.body === "three") === true, "three");
    expect(thread?.messages.filter((m) => m.body === "one")).toHaveLength(1);
    await second.runtime.stop();
  });

  it("does not post a redelivered update twice when the offset was lost", async () => {
    const fake = fakeWithBots();
    const directory = stateDir();
    const first = await open(fake, { token: TOKEN_A, identityKey: "telegram:bot:5001", directory });
    const update = fake.privateText(TOKEN_A, PERSON, "once");
    await waitFor(() => first.gateway.threads.size === 1, "posted");
    await first.runtime.stop();
    first.gateway.revoke();
    rmSync(join(directory, TELEGRAM_STATE_FILE));
    // Telegram redelivers an update that was never confirmed.
    fake.push(TOKEN_A, {
      ...(update.message as object),
      message_id: update.message?.message_id,
    } as never);
    await open(fake, {
      token: TOKEN_A,
      identityKey: "telegram:bot:5001",
      directory,
      gateway: first.gateway,
      reason: "restore",
    });
    await waitFor(() => fake.pending(TOKEN_A) === 0, "drained");
    const [thread] = [...first.gateway.threads.values()];
    await waitFor(() => first.gateway.receiveCalls.length >= 2, "redelivered");
    expect(thread?.messages.filter((m) => m.body === "once")).toHaveLength(1);
  });

  it("reports a revoked token, stops polling and keeps unsent replies for a relink", async () => {
    const fake = fakeWithBots();
    const directory = stateDir();
    const { runtime, gateway, request } = await open(fake, {
      token: TOKEN_A,
      identityKey: "telegram:bot:5001",
      directory,
    });
    fake.privateText(TOKEN_A, PERSON, "hi");
    await waitFor(() => gateway.threads.size === 1, "thread");
    fake.revoke(TOKEN_A);
    await waitFor(() => gateway.logs.some((l) => l.message.includes("polling stopped")), "revoked");
    const status = await runtime.status(request.connectionId);
    expect(status).toMatchObject({ phase: "revoked", message: REVOKED_MESSAGE });
    const polls = fake.offsets(TOKEN_A).length;
    await new Promise((done) => setTimeout(done, 50));
    expect(fake.offsets(TOKEN_A).length).toBe(polls);

    const [thread] = [...gateway.threads.values()];
    const reply = gateway.append(thread?.thread.id ?? "", { body: "held for the relink" });
    await new Promise((done) => setTimeout(done, 30));
    expect(gateway.receipts.has(`${reply.threadId}:${reply.seq}`)).toBe(false);

    // Relink: the same bot with a rotated token; the held reply goes out once.
    fake.addBot({ ...BOT_A, token: TOKEN_A_ROTATED });
    await runtime.close(request.connectionId, "relink");
    await open(fake, {
      token: TOKEN_A_ROTATED,
      identityKey: "telegram:bot:5001",
      directory,
      gateway,
      runtime,
      credentialGeneration: 2,
      reason: "relink",
    });
    await waitFor(() => fake.sends.some((s) => s.text === "held for the relink"), "relinked send");
    expect(fake.sends.filter((s) => s.text === "held for the relink")).toHaveLength(1);

    // Opening with a token Telegram refuses reports `revoked` at once.
    const refused = await runtime.open(
      { ...request, connectionId: "conn-revoked", stateDirectory: stateDir() },
      new FakeConnectionGateway("conn-revoked", "ws-1", "bot-a").issue(),
    );
    expect(refused.phase).toBe("revoked");
  });

  it("keeps two connections with different bots apart (decisions 3 to 5)", async () => {
    const fake = fakeWithBots();
    const runtime = await runtimeFor(fake);
    const a = await open(fake, {
      token: TOKEN_A,
      identityKey: "telegram:bot:5001",
      connectionId: "conn-a",
      botId: "bot-a",
      runtime,
    });
    const b = await open(fake, {
      token: TOKEN_B,
      identityKey: "telegram:bot:6002",
      connectionId: "conn-b",
      botId: "bot-b",
      runtime,
    });
    // The same person writes to both bots, with colliding message ids.
    fake.privateText(TOKEN_A, PERSON, "to alpha", { message_id: 1 });
    fake.privateText(TOKEN_B, PERSON, "to bravo", { message_id: 1 });
    await waitFor(() => a.gateway.threads.size === 1 && b.gateway.threads.size === 1, "both");
    const [threadA] = [...a.gateway.threads.values()];
    const [threadB] = [...b.gateway.threads.values()];
    expect(threadA?.messages.map((m) => m.body)).toEqual(["to alpha"]);
    expect(threadB?.messages.map((m) => m.body)).toEqual(["to bravo"]);

    a.gateway.append(threadA?.thread.id ?? "", { body: "alpha answers" });
    b.gateway.append(threadB?.thread.id ?? "", { body: "bravo answers" });
    await waitFor(() => fake.sends.length === 2, "two replies");
    expect(fake.sends.find((s) => s.text === "alpha answers")?.botId).toBe(5001);
    expect(fake.sends.find((s) => s.text === "bravo answers")?.botId).toBe(6002);

    // Closing one leaves the other running.
    await runtime.close("conn-a", "disconnect");
    a.gateway.revoke();
    fake.privateText(TOKEN_B, PERSON, "still there?");
    await waitFor(() => threadB?.messages.length === 3, "b still polls");
    expect((await runtime.status("conn-a")).phase).toBe("stopped");
  });

  it("drops relay cursors of an older binding generation on a rebind", async () => {
    const fake = fakeWithBots();
    const directory = stateDir();
    const first = await open(fake, { token: TOKEN_A, identityKey: "telegram:bot:5001", directory });
    fake.privateText(TOKEN_A, PERSON, "hello");
    await waitFor(() => first.gateway.threads.size === 1, "thread");
    const before = JSON.parse(readFileSync(join(directory, TELEGRAM_STATE_FILE), "utf8"));
    expect(Object.keys(before.threads)).toHaveLength(1);
    await first.runtime.close(first.request.connectionId, "rebind");
    const rebound = new FakeConnectionGateway("conn-a", "ws-1", "bot-other");
    await open(fake, {
      token: TOKEN_A,
      identityKey: "telegram:bot:5001",
      directory,
      gateway: rebound,
      runtime: first.runtime,
      bindingGeneration: 2,
      reason: "rebind",
    });
    const after = JSON.parse(readFileSync(join(directory, TELEGRAM_STATE_FILE), "utf8"));
    expect(after.threads).toEqual({});
    expect(after.offset).toBe(before.offset);
  });

  it("never writes the token to a log line, a status, a host call or the state file (decision 14)", async () => {
    const fake = fakeWithBots();
    const directory = stateDir();
    const contextLogs: unknown[] = [];
    const runtime = await runtimeFor(fake, contextLogs);
    const { gateway, request } = await open(fake, {
      token: TOKEN_A,
      identityKey: "telegram:bot:5001",
      directory,
      runtime,
    });
    fake.privateText(TOKEN_A, PERSON, "hello");
    await waitFor(() => gateway.threads.size === 1, "thread");
    const [thread] = [...gateway.threads.values()];
    // Exercise the warn paths: a transient and a permanent send failure, a failed poll.
    fake.sendFailures.push({ error_code: 500, description: `boom ${TOKEN_A}` });
    fake.sendFailures.push({
      error_code: 403,
      description: "Forbidden: bot was blocked by the user",
    });
    fake.pollFailures.push({ error_code: 502, description: `Bad Gateway ${TOKEN_A}` });
    gateway.append(thread?.thread.id ?? "", { body: "one" });
    await waitFor(() => gateway.logs.some((l) => l.message.includes("dropping it")), "permanent");
    fake.privateText(TOKEN_A, PERSON, "after the poll failure");
    await waitFor(() => thread?.messages.length === 3, "polled again");
    const status = await runtime.status(request.connectionId);
    fake.revoke(TOKEN_A);
    await waitFor(() => gateway.logs.some((l) => l.message.includes("polling stopped")), "revoked");

    const files = readdirSync(directory).map((name) => readFileSync(join(directory, name), "utf8"));
    const everything = JSON.stringify({
      logs: gateway.logs,
      contextLogs,
      status,
      revoked: await runtime.status(request.connectionId),
      receive: gateway.receiveCalls,
      threads: [...gateway.threads.values()].map((t) => t.thread),
      files,
    });
    const secret = TOKEN_A.slice(TOKEN_A.indexOf(":") + 1);
    expect(everything).not.toContain(secret);
    expect(statSync(join(directory, TELEGRAM_STATE_FILE)).mode & 0o777).toBe(0o600);
  });
});

describe("Telegram ongoing information synchronization", () => {
  it("answers help and status without creating or resetting work, and refuses task controls", async () => {
    const fake = fakeWithBots();
    const { gateway } = await open(fake, { token: TOKEN_A, identityKey: "telegram:bot:5001" });
    for (const command of ["/start", "/help@alpha_bot", "/new", "/reset", "/stop", "/status"]) {
      fake.privateText(TOKEN_A, PERSON, command);
    }
    await waitFor(() => fake.sends.length === 6, "information replies");
    expect(gateway.threads.size).toBe(0);
    expect(fake.sends[0]?.text).toBe(CONTINUITY_HELP);
    expect(fake.sends[2]?.text).toContain("Unknown command");
    expect(fake.sends[5]?.text).toContain("No work");
    fake.privateText(TOKEN_A, PERSON, "Keep watching the project");
    await waitFor(() => gateway.threads.size === 1, "ongoing conversation");
    fake.privateText(TOKEN_A, PERSON, "/status");
    await waitFor(() => fake.sends.length === 7, "status");
    expect([...gateway.threads.values()][0]?.messages).toHaveLength(1);
    gateway.blocked.add(String(PERSON));
    fake.privateText(TOKEN_A, PERSON, "/help");
    await waitFor(() => fake.pending(TOKEN_A) === 0, "blocked help");
    expect(fake.sends).toHaveLength(7);
  });

  it("discovers a lost local cursor and drains a paged offline backlog in order once", async () => {
    const fake = fakeWithBots();
    const first = await open(fake, { token: TOKEN_A, identityKey: "telegram:bot:5001" });
    fake.privateText(TOKEN_A, PERSON, "Keep me updated");
    await waitFor(() => first.gateway.threads.size === 1 && fake.pending(TOKEN_A) === 0, "thread");
    const thread = [...first.gateway.threads.keys()][0] as string;
    first.gateway.append(thread, { body: "already delivered" });
    await waitFor(() => first.gateway.receipts.size === 1, "first receipt");
    await first.runtime.close(first.request.connectionId, "reconnect");
    first.gateway.messagePageSize = 2;
    for (let i = 0; i < 7; i++) first.gateway.append(thread, { body: `update ${i}` });
    await open(fake, {
      token: TOKEN_A,
      identityKey: "telegram:bot:5001",
      gateway: first.gateway,
      runtime: first.runtime,
      directory: stateDir(),
      reason: "reconnect",
    });
    await waitFor(() => first.gateway.receipts.size === 8, "complete paged catchup");
    expect(fake.sends.map((s) => s.text)).toEqual([
      "already delivered",
      ...Array.from({ length: 7 }, (_, i) => `update ${i}`),
    ]);
  });

  it("honors rate-limit backoff despite new events and persists delivery diagnostics", async () => {
    const fake = fakeWithBots();
    const { gateway, request, runtime } = await open(fake, {
      token: TOKEN_A,
      identityKey: "telegram:bot:5001",
    });
    fake.privateText(TOKEN_A, PERSON, "updates");
    await waitFor(() => gateway.threads.size === 1, "thread");
    const thread = [...gateway.threads.keys()][0] as string;
    fake.sendFailures.push({ error_code: 429, description: "wait", retry_after: 0.15 });
    gateway.append(thread, { body: "first" });
    await waitFor(() => fake.sendFailures.length === 0, "rate limited");
    for (let i = 0; i < 10; i++) gateway.append(thread, { body: `next ${i}` });
    await new Promise((done) => setTimeout(done, 40));
    expect(fake.sends).toHaveLength(0);
    await waitFor(() => gateway.receipts.size === 11, "retry and catchup");
    fake.sendFailures.push({ error_code: 400, description: "refused" });
    gateway.append(thread, { body: "refused message" });
    await waitFor(() => gateway.logs.some((l) => l.message.includes("dropping it")), "refusal");
    await runtime.close(request.connectionId, "reconnect");
    const state = JSON.parse(
      readFileSync(join(request.stateDirectory, TELEGRAM_STATE_FILE), "utf8"),
    );
    expect(state.threads[thread].failedDelivery).toEqual({ seq: 13, status: 400 });
    expect(gateway.receipts.has(`${thread}:13`)).toBe(false);
  });
});

it("inspects and synchronizes only the chosen menu target, preserving custom buttons and ordinary chat", async () => {
  const fake = fakeWithBots();
  const { runtime, request, gateway } = await open(fake, {
    token: TOKEN_A,
    identityKey: "telegram:bot:5001",
  });
  expect(fake.calls.some((c) => c.method === "setMyCommands")).toBe(false);
  const input = {
    operation: "inspect" as const,
    scope: "chat" as const,
    chatId: "42",
    languageCode: "zh",
  };
  expect(await runtime.commandMenu?.(request.connectionId, input)).toMatchObject({
    commands: [{ command: "legacy" }],
    menuButton: "web_app",
  });
  for (let i = 0; i < 2; i++)
    expect(
      await runtime.commandMenu?.(request.connectionId, { ...input, operation: "sync" }),
    ).toEqual({ commands: TELEGRAM_COMMANDS, menuButton: "web_app" });
  expect(fake.calls.filter((c) => c.method === "setMyCommands").map((c) => c.params)).toEqual(
    Array(2).fill({
      scope: { type: "chat", chat_id: "42" },
      language_code: "zh",
      commands: TELEGRAM_COMMANDS,
    }),
  );
  expect(fake.calls.some((c) => c.method === "setChatMenuButton")).toBe(false);
  await runtime.commandMenu?.(request.connectionId, {
    ...input,
    operation: "sync",
    replaceMenuButton: true,
  });
  expect(fake.menuButton).toBe("commands");
  expect(
    (await runtime.commandMenu?.(request.connectionId, { operation: "inspect", scope: "default" }))
      ?.commands[0]?.command,
  ).toBe("legacy");
  fake.failMenu = true;
  await expect(
    runtime.commandMenu?.(request.connectionId, { ...input, operation: "sync" }),
  ).rejects.toThrow();
  fake.privateText(TOKEN_A, PERSON, "still working");
  await waitFor(() => gateway.threads.size === 1, "chat after menu failure");
  expect((await runtime.status(request.connectionId)).phase).toBe("connected");
  await runtime.close(request.connectionId, "reconnect");
  const calls = fake.calls.filter((c) => c.method === "setMyCommands").length;
  await open(fake, {
    token: TOKEN_A,
    identityKey: "telegram:bot:5001",
    gateway,
    runtime,
    directory: request.stateDirectory,
    reason: "reconnect",
  });
  expect(fake.calls.filter((c) => c.method === "setMyCommands")).toHaveLength(calls);
});

it("keeps an inbound update through more than five Gateway failures", async () => {
  const fake = fakeWithBots();
  const gateway = new FakeConnectionGateway("conn-a", "ws-1", "bot-a");
  const issue = gateway.issue.bind(gateway);
  let attempts = 0;
  vi.spyOn(gateway, "issue").mockImplementation(() => {
    const host = issue();
    return {
      ...host,
      receive: async (input) => {
        if (input.body && ++attempts <= 6) throw new Error("Gateway temporarily unavailable");
        return host.receive(input);
      },
    };
  });
  await open(fake, { token: TOKEN_A, identityKey: "telegram:bot:5001", gateway });
  fake.privateText(TOKEN_A, PERSON, "retain this update");
  await waitFor(
    () => gateway.threads.size === 1 && fake.pending(TOKEN_A) === 0,
    "recovered inbound",
  );
  expect(attempts).toBe(7);
  expect([...gateway.threads.values()][0]?.messages).toHaveLength(1);
});
