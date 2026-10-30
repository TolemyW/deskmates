// T1: the WhatsApp plugin on ChannelPlugin ABI 2 (ADR-0047 amendment 1) against a fake
// connection host, a fake Graph API and a fake linked-device socket. Inbound goes through
// `receive`, outbound through the send gate, the identity is verified (Cloud API) or claimed
// after the scan (QR), any sender is admitted unless the connection blocks them (ADR-0017
// amendment 3), a blocked sender gets nothing either way, and a stale host has no effect. The
// Gateway half (migration, real host, single connection) is
// `packages/gateway/src/channels/whatsapp-abi2.test.ts`.

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APPROVAL_ATTACHMENT_MIME,
  type Approval,
  type ChannelOpenRequest,
  channelManifestV2Problems,
  channelPendingIdentityKey,
} from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { type FakeGraph, createFakeGraph } from "../test-support/fake-graph.js";
import {
  type FakeConnectionHost,
  createFakeConnectionHost,
} from "../test-support/fake-whatsapp-connection-host.js";
import type { SocketCallbacks } from "../whatsapp-web/session.js";
import { UNSUPPORTED_NOTICE } from "./adapter.js";
import { WhatsAppPluginRuntime, channelPlugin } from "./plugin.js";
import { SIGNATURE_HEADER, signBody } from "./signature.js";

const PHONE_ID = "100200";
const SENDER = "8613800000000";
const STRANGER = "15550009999";
const APP_SECRET = "app-secret-value";
const ACCOUNT = "15550001111";

const dirs: string[] = [];
const runtimes: WhatsAppPluginRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const settle = () => new Promise((done) => setTimeout(done, 20));

function graph(): FakeGraph {
  const fake = createFakeGraph();
  const send = fake.fetch;
  fake.fetch = async (input, init) => {
    if (!init?.method || init.method === "GET")
      return Response.json({
        id: PHONE_ID,
        display_phone_number: "+1 555 0100",
        verified_name: "Ops",
      });
    return send(input, init);
  };
  return fake;
}

function runtime(fake: FakeGraph, sockets: SocketCallbacks[] = [], calls: string[] = []) {
  const created = new WhatsAppPluginRuntime(
    { log: () => {} },
    {
      fetch: fake.fetch,
      encodeQr: async (qr) => `data:image/png;base64,${qr}`,
      createSocket: async (_store, callbacks) => {
        sockets.push(callbacks);
        return {
          end: () => {
            calls.push("end");
          },
          logout: async () => {
            calls.push("logout");
          },
          send: async () => `out${sockets.length}`,
          resolveLid: async () => null,
        };
      },
      relayRetry: { initialMs: 5, maxMs: 10 },
    },
  );
  runtimes.push(created);
  return created;
}

function request(method: "cloud" | "qr", overrides: Partial<ChannelOpenRequest> = {}) {
  const stateDirectory = mkdtempSync(join(tmpdir(), "deskmates-wa-abi2-"));
  dirs.push(stateDirectory);
  return {
    connectionId: "chn_fake",
    workspaceId: "ws_1",
    botId: "bot_1",
    identityKey: method === "cloud" ? `whatsapp:cloud:${PHONE_ID}` : `whatsapp:linked:${ACCOUNT}`,
    bindingGeneration: 1,
    credentialGeneration: 1,
    reason: "connect",
    method,
    config:
      method === "cloud"
        ? { phoneNumberId: PHONE_ID, graphBaseUrl: "https://graph.example.test" }
        : {},
    secrets:
      method === "cloud"
        ? { accessToken: "EAAB-token", appSecret: APP_SECRET, verifyToken: "verify" }
        : {},
    stateDirectory,
    ...overrides,
  } as ChannelOpenRequest;
}

function webhook(messages: unknown[]) {
  const body = Buffer.from(
    JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "1555", phone_number_id: PHONE_ID },
                messages,
              },
            },
          ],
        },
      ],
    }),
  );
  return {
    connectionId: "chn_fake",
    method: "POST" as const,
    url: "/api/channel-webhooks/ws_1/whatsapp",
    headers: { [SIGNATURE_HEADER]: signBody(body, APP_SECRET) },
    body: new Uint8Array(body),
  };
}

const text = (from: string, id: string, body: string) => ({
  from,
  id,
  timestamp: "1",
  type: "text",
  text: { body },
});

async function cloud(host: FakeConnectionHost, fake = graph()) {
  const plugin = runtime(fake);
  const status = await plugin.open(request("cloud"), host);
  expect(status).toEqual({ phase: "connected", account: PHONE_ID });
  return { plugin, fake };
}

describe("the WhatsApp ABI-2 manifest", () => {
  it("is a loadable single-connection, allow-by-default plugin whose QR identity comes at link", () => {
    expect(channelManifestV2Problems(channelPlugin.manifest)).toEqual([]);
    expect(channelPlugin.manifest).toMatchObject({
      apiVersion: 2,
      id: "whatsapp",
      multipleConnections: false,
      // ADR-0017 amendment 3: the connection's blocklist, no allowlist field.
      senderAdmission: { mode: "blocklist" },
    });
    const fields = channelPlugin.manifest.methods.flatMap((m) => m.fields.map((f) => f.key));
    expect(fields).not.toContain("allowedSenders");
    expect(channelPlugin.manifest.methods.map((m) => [m.id, m.identity ?? "verify"])).toEqual([
      ["qr", "link"],
      ["cloud", "verify"],
    ]);
  });
});

describe("the Cloud API method through the ABI-2 host", () => {
  it("verifies the number against the Graph API, never from the typed id alone", async () => {
    const fake = graph();
    const plugin = runtime(fake);
    const identity = await plugin.verify({
      workspaceId: "ws_1" as never,
      method: "cloud",
      config: { phoneNumberId: PHONE_ID, graphBaseUrl: "https://graph.example.test" },
      secrets: { accessToken: "EAAB-token" },
    });
    expect(identity).toEqual({
      identityKey: `whatsapp:cloud:${PHONE_ID}`,
      label: "Ops (+1 555 0100)",
    });
    expect(JSON.stringify(identity)).not.toContain("EAAB");
    await expect(
      plugin.verify({
        workspaceId: "ws_1" as never,
        method: "cloud",
        config: { phoneNumberId: "999", graphBaseUrl: "https://graph.example.test" },
        secrets: { accessToken: "EAAB-token" },
      }),
    ).rejects.toThrow(/another phone number id/);
  });

  it("posts inbound through receive and relays the reply through the send gate", async () => {
    const host = createFakeConnectionHost();
    const { plugin, fake } = await cloud(host);
    expect(host.claims).toEqual([]);
    expect((await plugin.webhook(webhook([text(SENDER, "wamid.1", "hello")]))).status).toBe(200);
    expect(host.received).toEqual([
      {
        conversationKey: `${PHONE_ID}:${SENDER}`,
        senderId: SENDER,
        externalId: "wamid.1",
        body: "hello",
        title: `WhatsApp ${SENDER}`,
      },
    ]);
    const [threadId] = [...host.threads.keys()];
    host.append(threadId as string, { body: "hi there" });
    await settle();
    expect(fake.sends.map((send) => (send.body.text as { body: string }).body)).toEqual([
      "Helper: hi there",
    ]);
    expect(host.sent).toEqual([{ threadId, seq: 2, providerMessageIds: ["wamid.out.1"] }]);
    // A redelivered webhook posts nothing new and sends nothing.
    expect((await plugin.webhook(webhook([text(SENDER, "wamid.1", "hello")]))).status).toBe(200);
    await settle();
    expect(host.received).toHaveLength(1);
    expect(fake.sends).toHaveLength(1);
  });

  it("admits a sender it has never seen (ADR-0017 amendment 3) and answers them", async () => {
    const host = createFakeConnectionHost();
    const { plugin, fake } = await cloud(host);
    expect((await plugin.webhook(webhook([text(STRANGER, "wamid.1", "hi")]))).status).toBe(200);
    expect(host.received.map((r) => r.senderId)).toEqual([STRANGER]);
    const [threadId] = [...host.threads.keys()];
    host.append(threadId as string, { body: "hello stranger" });
    await settle();
    expect(fake.sends.map((send) => send.body.to)).toEqual([STRANGER]);
    // An admitted sender's image still gets the text-only notice, as on ABI 1.
    await plugin.webhook(
      webhook([{ from: STRANGER, id: "wamid.2", timestamp: "1", type: "image" }]),
    );
    expect(fake.sends.map((send) => (send.body.text as { body: string }).body)).toEqual([
      "Helper: hello stranger",
      UNSUPPORTED_NOTICE,
    ]);
  });

  it("gives a blocked sender nothing: no thread, no notice, no decision, no send", async () => {
    const host = createFakeConnectionHost();
    host.blocked.add(STRANGER);
    const { plugin, fake } = await cloud(host);
    const unsupported = { from: STRANGER, id: "wamid.2", timestamp: "1", type: "image" };
    const approve = text(STRANGER, "wamid.3", "approve 0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b");
    expect(
      (
        await plugin.webhook(
          webhook([text(STRANGER, "wamid.1", "let me in"), unsupported, approve]),
        )
      ).status,
    ).toBe(200);
    await settle();
    expect(host.threads.size).toBe(0);
    expect(host.decided).toEqual([]);
    expect(fake.sends).toEqual([]);
  });

  it("stops relaying to a person once blocked and does not replay after unblocking", async () => {
    const host = createFakeConnectionHost();
    const { plugin, fake } = await cloud(host);
    await plugin.webhook(webhook([text(SENDER, "wamid.1", "hello")]));
    const [threadId] = [...host.threads.keys()];
    host.blocked.add(SENDER);
    host.append(threadId as string, { body: "not for you" });
    await settle();
    expect(fake.sends).toEqual([]);
    host.blocked.delete(SENDER);
    host.append(threadId as string, { body: "for you again" });
    await settle();
    expect(fake.sends.map((send) => (send.body.text as { body: string }).body)).toEqual([
      "Helper: for you again",
    ]);
  });

  it("sends a test message to any number the connection does not block (amendment 3 S4)", async () => {
    const host = createFakeConnectionHost();
    host.blocked.add(STRANGER);
    const { plugin, fake } = await cloud(host);
    await expect(plugin.test("chn_fake", { to: `+${STRANGER}` })).rejects.toThrow(/blocked/);
    expect(fake.sends).toEqual([]);
    await plugin.test("chn_fake", { to: "15550004444", text: "ping" });
    expect(fake.sends.map((send) => send.body.to)).toEqual(["15550004444"]);
  });

  it("decides an approval of the sender's own thread and never posts the command", async () => {
    const host = createFakeConnectionHost();
    const { plugin, fake } = await cloud(host);
    await plugin.webhook(webhook([text(SENDER, "wamid.1", "hello")]));
    const [threadId] = [...host.threads.keys()];
    const id = "0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b";
    host.approvals.set(id, { id, threadId } as Approval);
    host.append(threadId as string, {
      authorKind: "system",
      authorId: "",
      body: "approve?",
      attachments: [{ ref: id, mimeType: APPROVAL_ATTACHMENT_MIME } as never],
    });
    await plugin.webhook(webhook([text(SENDER, "wamid.2", `approve ${id}`)]));
    expect(host.decided).toEqual([{ id, decision: "allow_once", senderId: SENDER }]);
    expect(host.received).toHaveLength(1);
    // Once blocked, the same person decides nothing and gets no refusal notice (amendment 3 S3).
    host.blocked.add(SENDER);
    const sends = fake.sends.length;
    await plugin.webhook(webhook([text(SENDER, "wamid.3", `deny ${id}`)]));
    await settle();
    expect(host.decided).toHaveLength(1);
    expect(fake.sends).toHaveLength(sends);
  });

  it("asks Meta to retry when the host went stale, and creates nothing", async () => {
    const host = createFakeConnectionHost();
    const { plugin, fake } = await cloud(host);
    host.stale = true;
    expect((await plugin.webhook(webhook([text(SENDER, "wamid.1", "late")]))).status).toBe(503);
    expect(host.received).toEqual([]);
    expect(fake.sends).toEqual([]);
  });

  it("claims the configured number of a connection moved from ABI 1", async () => {
    const host = createFakeConnectionHost();
    const plugin = runtime(graph());
    await plugin.open(
      request("cloud", { identityKey: channelPendingIdentityKey("whatsapp", "chn_fake") }),
      host,
    );
    expect(host.claims).toEqual([{ identityKey: `whatsapp:cloud:${PHONE_ID}`, label: PHONE_ID }]);
    const second = createFakeConnectionHost();
    second.refuseClaim = "channel_identity_in_use";
    const other = runtime(graph());
    const status = await other.open(
      request("cloud", { identityKey: channelPendingIdentityKey("whatsapp", "chn_fake") }),
      second,
    );
    expect(status.phase).toBe("error");
    expect(status.message).toMatch(/already connected/);
    expect((await other.webhook(webhook([text(SENDER, "wamid.1", "hi")]))).status).toBe(503);
    expect(second.received).toEqual([]);
  });
});

describe("the QR method through the ABI-2 host", () => {
  it("claims the linked number after the scan and keeps the state directory private", async () => {
    const sockets: SocketCallbacks[] = [];
    const host = createFakeConnectionHost();
    const plugin = runtime(graph(), sockets);
    const open = request("qr", { identityKey: channelPendingIdentityKey("whatsapp", "chn_fake") });
    await plugin.open(open, host);
    sockets[0]?.update({ qr: "qr-one" });
    await settle();
    expect((await plugin.status("chn_fake")).qr).toBe("data:image/png;base64,qr-one");
    sockets[0]?.update({ connection: "open", account: `${ACCOUNT}@s.whatsapp.net` });
    await settle();
    expect(host.claims).toEqual([
      { identityKey: `whatsapp:linked:${ACCOUNT}`, label: `+${ACCOUNT}` },
    ]);
    expect((await plugin.status("chn_fake")).phase).toBe("connected");
    expect(statSync(open.stateDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(join(open.stateDirectory, "session.json")).mode & 0o777).toBe(0o600);
    sockets[0]?.messages("notify", [
      { key: { remoteJid: `${SENDER}@s.whatsapp.net`, id: "m1" }, message: { conversation: "hi" } },
    ] as never);
    await settle();
    expect(host.received).toEqual([
      {
        conversationKey: `web:${ACCOUNT}:${SENDER}`,
        senderId: SENDER,
        externalId: `web:${ACCOUNT}:m1`,
        body: "hi",
        title: `WhatsApp ${SENDER}`,
      },
    ]);
  });

  it("keeps the link and its state when archived and logs out only on disconnect (ADR-0017 amendment 1 P6)", async () => {
    const sockets: SocketCallbacks[] = [];
    const calls: string[] = [];
    const host = createFakeConnectionHost();
    const plugin = runtime(graph(), sockets, calls);
    const open = request("qr");
    await plugin.open(open, host);
    sockets[0]?.update({ connection: "open", account: `${ACCOUNT}@s.whatsapp.net` });
    await settle();
    await plugin.close("chn_fake", "archive");
    expect(calls).not.toContain("logout");
    expect(statSync(join(open.stateDirectory, "session.json")).mode & 0o777).toBe(0o600);
    expect(calls).toContain("end");
    // The same state opens again; only a disconnect logs the linked device out.
    await plugin.open({ ...open, reason: "reconnect" }, host);
    await settle();
    expect(sockets).toHaveLength(2);
    await plugin.close("chn_fake", "disconnect");
    expect(calls).toContain("logout");
  });

  it("refuses a linked number connected elsewhere and relays nothing for it", async () => {
    const sockets: SocketCallbacks[] = [];
    const host = createFakeConnectionHost();
    host.refuseClaim = "channel_identity_in_use";
    const plugin = runtime(graph(), sockets);
    await plugin.open(request("qr"), host);
    sockets[0]?.update({ connection: "open", account: `${ACCOUNT}@s.whatsapp.net` });
    await settle();
    const status = await plugin.status("chn_fake");
    expect(status.phase).toBe("error");
    expect(status.message).toMatch(/already connected/);
    sockets[0]?.messages("notify", [
      { key: { remoteJid: `${SENDER}@s.whatsapp.net`, id: "m1" }, message: { conversation: "hi" } },
    ] as never);
    await settle();
    expect(host.received).toEqual([]);
  });
});
