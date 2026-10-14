// T1: the adapter against a fake Gateway on a real port and a fake Graph API (ADR-0017
// decisions 3 to 8). The Gateway-side counterpart, `thread-channel-routes.test.ts`, proves the
// real routes answer the same request sequence.

import { APPROVAL_ATTACHMENT_MIME, type Approval } from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeGateway, startFakeGateway } from "../test-support/fake-gateway.js";
import { type FakeGraph, createFakeGraph } from "../test-support/fake-graph.js";
import {
  APPROVAL_REFUSED_NOTICE,
  type AdapterLog,
  UNSUPPORTED_NOTICE,
  WhatsAppAdapter,
} from "./adapter.js";
import type { WhatsAppConfig } from "./config.js";
import { GatewayClient } from "./gateway-client.js";
import { MemoryStateStore } from "./state.js";

const SENDER = "8613800000000";
const STRANGER = "15550009999";
const PHONE_ID = "100200";
const ACCESS_TOKEN = "EAAB-very-secret-token";
const APP_SECRET = "app-secret-value";

function config(overrides: Partial<WhatsAppConfig> = {}): WhatsAppConfig {
  return {
    port: 0,
    bind: "127.0.0.1",
    verifyToken: "verify",
    appSecret: APP_SECRET,
    accessToken: ACCESS_TOKEN,
    phoneNumberId: PHONE_ID,
    graphBaseUrl: "https://graph.example.test",
    graphApiVersion: "v23.0",
    allowedSenders: new Set([SENDER]),
    gatewayUrl: "unused",
    operatorToken: "unused",
    workspaceId: "ws_1",
    botIds: ["bot_nova", "bot_rex"],
    stateFile: "unused",
    sendRetries: 2,
    ...overrides,
  };
}

function textMessage(from: string, id: string, text: string, phoneNumberId = PHONE_ID): unknown {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "1555", phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: "Secret Profile Name" }, wa_id: from }],
              messages: [{ from, id, timestamp: "1", type: "text", text: { body: text } }],
            },
          },
        ],
      },
    ],
  };
}

function imageMessage(from: string, id: string): unknown {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: PHONE_ID },
              messages: [{ from, id, timestamp: "1", type: "image", image: { id: "media" } }],
            },
          },
        ],
      },
    ],
  };
}

let gateway: FakeGateway;
let graph: FakeGraph;
let logs: { level: string; message: string; data?: Record<string, unknown> }[];
let adapter: WhatsAppAdapter;
let state: MemoryStateStore;

const log: AdapterLog = {
  info: (message, data) => logs.push({ level: "info", message, ...(data ? { data } : {}) }),
  warn: (message, data) => logs.push({ level: "warn", message, ...(data ? { data } : {}) }),
};

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeEach(async () => {
  gateway = await startFakeGateway();
  gateway.addBot("bot_nova", "nova");
  gateway.addBot("bot_rex", "rex");
  graph = createFakeGraph();
  logs = [];
  state = new MemoryStateStore();
  adapter = new WhatsAppAdapter({
    config: config(),
    gateway: new GatewayClient({ baseUrl: gateway.baseUrl, operatorToken: gateway.token }),
    state,
    fetch: graph.fetch,
    log,
    sleep: async () => {},
  });
});

afterEach(async () => {
  await adapter.stop();
  await gateway.close();
});

describe("inbound", () => {
  it("binds the sender to one thread, posts idempotently and never forwards the profile", async () => {
    const first = await adapter.handleWebhook(
      textMessage(SENDER, "wamid.1", "@nova what is open?"),
    );
    expect(first.status).toBe(200);
    const threads = gateway.threads();
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      channel: "whatsapp",
      externalKey: `${PHONE_ID}:${SENDER}`,
      title: `WhatsApp ${SENDER}`,
      workspaceId: "ws_1",
    });
    const threadId = threads[0]?.id as string;
    expect(gateway.messages(threadId)).toHaveLength(1);
    expect(gateway.messages(threadId)[0]).toMatchObject({
      authorKind: "human",
      authorId: `whatsapp:${SENDER}`,
      body: "@nova what is open?",
      externalId: "wamid.1",
    });

    // Meta retries the same delivery: the Gateway answers duplicate, nothing new is posted.
    const again = await adapter.handleWebhook(
      textMessage(SENDER, "wamid.1", "@nova what is open?"),
    );
    expect(again.status).toBe(200);
    expect(gateway.messages(threadId)).toHaveLength(1);
    expect(adapter.counters.inbound_duplicate).toBe(1);

    // A second message reuses the binding without another create.
    await adapter.handleWebhook(textMessage(SENDER, "wamid.2", "and the backlog?"));
    expect(gateway.threads()).toHaveLength(1);
    expect(gateway.messages(threadId)).toHaveLength(2);
    const creates = gateway.requests.filter(
      (r) => r.method === "POST" && r.path === "/api/threads",
    );
    expect(creates).toHaveLength(1);

    for (const request of gateway.requests) {
      expect(request.headers.authorization).toBe(`Bearer ${gateway.token}`);
      const serialized = JSON.stringify(request.body ?? {});
      expect(serialized).not.toContain("Secret Profile Name");
      expect(serialized).not.toContain(ACCESS_TOKEN);
      expect(serialized).not.toContain(APP_SECRET);
    }
    expect(JSON.stringify(logs)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(logs)).not.toContain(APP_SECRET);
  });

  it("drops senders off the allowlist and other phone numbers, acknowledging both", async () => {
    const stranger = await adapter.handleWebhook(textMessage(STRANGER, "wamid.s", "hello?"));
    expect(stranger.status).toBe(200);
    const other = await adapter.handleWebhook(textMessage(SENDER, "wamid.o", "hello?", "999"));
    expect(other.status).toBe(200);
    expect(gateway.threads()).toEqual([]);
    expect(gateway.requests).toEqual([]);
    expect(graph.sends).toEqual([]);
    expect(adapter.counters).toMatchObject({ dropped_unlisted_sender: 1, dropped_other_number: 1 });
    expect(logs.filter((l) => l.level === "warn")).toHaveLength(2);
  });

  it("answers a non-text message with one notice and posts nothing", async () => {
    const result = await adapter.handleWebhook(imageMessage(SENDER, "wamid.img"));
    expect(result.status).toBe(200);
    expect(gateway.threads()).toEqual([]);
    expect(graph.sends).toHaveLength(1);
    expect(graph.sends[0]?.body).toMatchObject({ to: SENDER, text: { body: UNSUPPORTED_NOTICE } });
    expect(adapter.counters.dropped_unsupported).toBe(1);
    // From a stranger, not even the notice.
    await adapter.handleWebhook(imageMessage(STRANGER, "wamid.img2"));
    expect(graph.sends).toHaveLength(1);
  });

  it("asks Meta to retry when the Gateway is down, and dedupes once it is back", async () => {
    gateway.unavailable = true;
    const down = await adapter.handleWebhook(textMessage(SENDER, "wamid.d", "are you there?"));
    expect(down.status).toBe(503);
    gateway.unavailable = false;
    const up = await adapter.handleWebhook(textMessage(SENDER, "wamid.d", "are you there?"));
    expect(up.status).toBe(200);
    const threadId = gateway.threads()[0]?.id as string;
    expect(gateway.messages(threadId)).toHaveLength(1);
  });

  it("reuses a thread the Gateway already has without replaying its history", async () => {
    // Another adapter instance bound this sender earlier and relayed two messages.
    await adapter.handleWebhook(textMessage(SENDER, "wamid.a", "first"));
    const threadId = gateway.threads()[0]?.id as string;
    gateway.append(threadId, { authorKind: "bot", authorId: "bot_nova", body: "old reply" });
    const fresh = new WhatsAppAdapter({
      config: config(),
      gateway: new GatewayClient({ baseUrl: gateway.baseUrl, operatorToken: gateway.token }),
      state: new MemoryStateStore(),
      fetch: graph.fetch,
      log,
      sleep: async () => {},
    });
    await fresh.handleWebhook(textMessage(SENDER, "wamid.b", "second"));
    expect(gateway.threads()).toHaveLength(1);
    fresh.start();
    await fresh.relay(threadId);
    await fresh.stop();
    // The old reply predates this instance's cursor; nothing was resent.
    expect(graph.sends).toEqual([]);
  });
});

describe("outbound relay", () => {
  it("relays bot and system messages with labels, chunks long ones, skips the sender's own", async () => {
    await adapter.handleWebhook(textMessage(SENDER, "wamid.1", "hello"));
    const threadId = gateway.threads()[0]?.id as string;
    adapter.start();
    await waitFor(
      () => gateway.requests.some((r) => r.path.startsWith("/api/events")),
      "the SSE subscription",
    );
    gateway.append(threadId, {
      authorKind: "bot",
      authorId: "bot_nova",
      body: "Three tickets are open.",
    });
    await waitFor(() => graph.sends.length === 1, "the first relay");
    expect(graph.sends[0]?.body).toMatchObject({
      to: SENDER,
      text: { body: "nova: Three tickets are open." },
    });
    expect(graph.sends[0]?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);

    gateway.append(threadId, { authorKind: "bot", authorId: "bot_rex", body: "r".repeat(5000) });
    await waitFor(() => graph.sends.length === 3, "two chunks");
    expect((graph.sends[1]?.body.text as { body: string }).body.length).toBeLessThanOrEqual(4096);
    expect((graph.sends[1]?.body.text as { body: string }).body.startsWith("rex: ")).toBe(true);

    gateway.append(threadId, { authorKind: "system", authorId: "", body: "turn budget reached" });
    await waitFor(() => graph.sends.length === 4, "the system notice");
    expect(graph.sends[3]?.body).toMatchObject({ text: { body: "turn budget reached" } });

    // The sender's own message, echoed by the Gateway's SSE, is not sent back to them; a web
    // operator's message is.
    await adapter.handleWebhook(textMessage(SENDER, "wamid.2", "thanks"));
    gateway.append(threadId, { authorKind: "human", authorId: "web", body: "ops here" });
    await waitFor(() => graph.sends.length === 5, "the operator message");
    expect(graph.sends[4]?.body).toMatchObject({ text: { body: "web: ops here" } });
    expect(graph.sends.some((s) => (s.body.text as { body: string }).body.includes("thanks"))).toBe(
      false,
    );
    expect(state.get(threadId)?.relayedSeq).toBe(gateway.messages(threadId).length);
    expect(adapter.counters.relayed).toBe(5);
  });

  it("retries 429 once, logs a permanent failure without retrying, and moves on", async () => {
    await adapter.handleWebhook(textMessage(SENDER, "wamid.1", "hello"));
    const threadId = gateway.threads()[0]?.id as string;
    adapter.start();
    await waitFor(
      () => gateway.requests.some((r) => r.path.startsWith("/api/events")),
      "the SSE subscription",
    );
    graph.queue.push({ status: 429, body: { error: { code: 130429, message: "rate" } } });
    gateway.append(threadId, { authorKind: "bot", authorId: "bot_nova", body: "one" });
    await waitFor(() => graph.sends.length === 2, "the retry");
    expect(adapter.counters.send_failed).toBe(0);

    graph.queue.push({
      status: 400,
      body: { error: { code: 131047, message: "Re-engagement message" } },
    });
    gateway.append(threadId, { authorKind: "bot", authorId: "bot_nova", body: "two" });
    gateway.append(threadId, { authorKind: "bot", authorId: "bot_nova", body: "three" });
    await waitFor(() => graph.sends.length === 4, "the failed send and the next message");
    expect(adapter.counters.send_failed).toBe(1);
    const failure = logs.find((l) => l.message.includes("WhatsApp refused a thread message"));
    expect(failure?.data).toMatchObject({ status: 400, code: 131047, attempts: 1 });
    expect(graph.sends[3]?.body).toMatchObject({ text: { body: "nova: three" } });
    expect(state.get(threadId)?.relayedSeq).toBe(gateway.messages(threadId).length);
  });

  it("catches up after a reconnect from the cursor, not from the beginning", async () => {
    await adapter.handleWebhook(textMessage(SENDER, "wamid.1", "hello"));
    const threadId = gateway.threads()[0]?.id as string;
    adapter.start();
    await waitFor(
      () => gateway.requests.some((r) => r.path.startsWith("/api/events")),
      "the SSE subscription",
    );
    gateway.append(threadId, { authorKind: "bot", authorId: "bot_nova", body: "one" });
    await waitFor(() => graph.sends.length === 1, "first relay");
    await adapter.stop();
    // Messages arrive while the adapter is away.
    gateway.append(threadId, { authorKind: "bot", authorId: "bot_nova", body: "two" });
    gateway.append(threadId, { authorKind: "bot", authorId: "bot_nova", body: "three" });
    adapter.start();
    await waitFor(() => graph.sends.length === 3, "catch-up on reconnect");
    expect(graph.sends.map((s) => (s.body.text as { body: string }).body)).toEqual([
      "nova: one",
      "nova: two",
      "nova: three",
    ]);
  });

  it("recovers a response-body disconnect without waiting for another thread event", async () => {
    await adapter.stop();
    let disconnected = true;
    const send: typeof fetch = async (input, init) =>
      disconnected
        ? new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("response body connection reset"));
              },
            }),
            { status: 503 },
          )
        : graph.fetch(input, init);
    adapter = new WhatsAppAdapter({
      config: config({ sendRetries: 0 }),
      gateway: new GatewayClient({ baseUrl: gateway.baseUrl, operatorToken: gateway.token }),
      state,
      fetch: send,
      log,
      relayRetry: { initialMs: 30, maxMs: 60 },
    });
    await adapter.handleWebhook(textMessage(SENDER, "wamid.body", "hello"));
    const threadId = gateway.threads()[0]?.id as string;
    adapter.start();
    await waitFor(
      () => gateway.requests.some((r) => r.path.startsWith("/api/events")),
      "the SSE subscription",
    );
    gateway.append(threadId, { authorKind: "bot", authorId: "bot_nova", body: "recovered reply" });
    await waitFor(() => adapter.counters.send_deferred > 0, "the deferred body failure");
    expect(state.get(threadId)?.relayedSeq).toBe(1);
    expect(graph.sends).toHaveLength(0);
    disconnected = false;
    await waitFor(() => state.get(threadId)?.relayedSeq === 2, "body-error recovery");
    expect(graph.sends).toHaveLength(1);
    expect(graph.sends[0]?.body).toMatchObject({ text: { body: "nova: recovered reply" } });
  });

  it("keeps the cursor on a transient failure and resumes the remaining chunks later", async () => {
    await adapter.stop();
    adapter = new WhatsAppAdapter({
      config: config({ sendRetries: 0 }),
      gateway: new GatewayClient({ baseUrl: gateway.baseUrl, operatorToken: gateway.token }),
      state,
      fetch: graph.fetch,
      log,
      sleep: async () => {},
      relayRetry: { initialMs: 60, maxMs: 120 },
    });
    await adapter.handleWebhook(textMessage(SENDER, "wamid.1", "hello"));
    const threadId = gateway.threads()[0]?.id as string;
    adapter.start();
    await waitFor(
      () => gateway.requests.some((r) => r.path.startsWith("/api/events")),
      "the SSE subscription",
    );
    // A two-chunk message: the first chunk goes out, then WhatsApp answers 503 until it recovers.
    const body = `${"a".repeat(3000)}\n${"b".repeat(3000)}`;
    graph.queue.push({ status: 200 }, { status: 503 }, { status: 503 }, { status: 503 });
    gateway.append(threadId, { authorKind: "bot", authorId: "bot_nova", body });
    gateway.append(threadId, { authorKind: "bot", authorId: "bot_nova", body: "after" });
    await waitFor(() => graph.sends.length >= 3, "the first chunk and two failing attempts");
    expect(state.get(threadId)?.relayedSeq).toBe(1);
    expect(state.get(threadId)?.sentChunks).toBe(1);
    expect(adapter.counters.send_failed).toBe(0);
    expect(adapter.counters.send_deferred).toBeGreaterThan(0);
    // Once the queue is empty the fake succeeds: the second chunk and the next message arrive;
    // the first chunk is never sent twice.
    await waitFor(() => state.get(threadId)?.relayedSeq === 3, "recovery", 5000);
    const bodies = graph.sends.map((s) => (s.body.text as { body: string }).body);
    expect(bodies.filter((b) => b.startsWith("nova: aaa"))).toHaveLength(1);
    expect(bodies.filter((b) => b.startsWith("bbb"))).toHaveLength(4);
    expect(bodies.filter((b) => b === "nova: after")).toHaveLength(1);
    expect(state.get(threadId)?.sentChunks).toBe(0);
  });

  it("stops relaying to a sender removed from the allowlist without replaying on return", async () => {
    await adapter.handleWebhook(textMessage(SENDER, "wamid.1", "hello"));
    const threadId = gateway.threads()[0]?.id as string;
    await adapter.stop();
    // Restart with the same state file and an allowlist that no longer names the sender.
    adapter = new WhatsAppAdapter({
      config: config({ allowedSenders: new Set() }),
      gateway: new GatewayClient({ baseUrl: gateway.baseUrl, operatorToken: gateway.token }),
      state,
      fetch: graph.fetch,
      log,
      sleep: async () => {},
    });
    adapter.start();
    await waitFor(
      () => gateway.requests.some((r) => r.path.startsWith("/api/events")),
      "the restarted adapter's SSE subscription",
    );
    gateway.append(threadId, { authorKind: "bot", authorId: "bot_nova", body: "secret reply" });
    await waitFor(() => state.get(threadId)?.relayedSeq === 2, "the cursor to move past it");
    expect(graph.sends).toEqual([]);
    expect(adapter.counters.dropped_delisted_recipient).toBe(1);
    expect(logs.some((l) => l.message.includes("no longer on the allowlist"))).toBe(true);
    // Their inbound is dropped too, and the notice for an unsupported message is not sent.
    await adapter.handleWebhook(textMessage(SENDER, "wamid.2", "still here?"));
    await adapter.handleWebhook(imageMessage(SENDER, "wamid.3"));
    expect(gateway.messages(threadId)).toHaveLength(2);
    expect(graph.sends).toEqual([]);
  });

  it("appends the reply instruction to an approval request", async () => {
    await adapter.handleWebhook(textMessage(SENDER, "wamid.1", "hello"));
    const threadId = gateway.threads()[0]?.id as string;
    adapter.start();
    await waitFor(
      () => gateway.requests.some((r) => r.path.startsWith("/api/events")),
      "the SSE subscription",
    );
    gateway.append(threadId, {
      authorKind: "system",
      authorId: "",
      body: "nova wants to run `git push` on github.com (L2).",
      attachments: [
        {
          name: "approval",
          mimeType: APPROVAL_ATTACHMENT_MIME,
          ref: "3f2a9c1e-8b4d-4e6f-9a0b-1c2d3e4f5a6b",
        },
      ],
    });
    await waitFor(() => graph.sends.length === 1, "the approval relay");
    expect((graph.sends[0]?.body.text as { body: string }).body).toBe(
      'nova wants to run `git push` on github.com (L2).\nReply "approve 3f2a9c1e-8b4d-4e6f-9a0b-1c2d3e4f5a6b" or "deny 3f2a9c1e-8b4d-4e6f-9a0b-1c2d3e4f5a6b [reason]".',
    );
  });
});

describe("approval commands", () => {
  function approval(id: string, threadId: string | undefined): Approval {
    return {
      id: id as Approval["id"],
      runId: "run_1" as Approval["runId"],
      botId: "bot_nova" as Approval["botId"],
      ...(threadId ? { threadId: threadId as NonNullable<Approval["threadId"]> } : {}),
      action: { toolName: "Bash", input: {} },
      riskLevel: "L2",
      waitMode: "deferred",
      createdAt: new Date().toISOString(),
    };
  }

  it("decides approvals of the sender's own thread and never posts the command", async () => {
    await adapter.handleWebhook(textMessage(SENDER, "wamid.1", "hello"));
    const threadId = gateway.threads()[0]?.id as string;
    gateway.addApproval(approval("3f2a9c1e-8b4d-4e6f-9a0b-1c2d3e4f5a6b", threadId));
    gateway.addApproval(approval("approval_0123456789abcdef0123456789abcdef", threadId));

    expect(
      (
        await adapter.handleWebhook(
          textMessage(SENDER, "wamid.2", "approve 3f2a9c1e-8b4d-4e6f-9a0b-1c2d3e4f5a6b"),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await adapter.handleWebhook(
          textMessage(SENDER, "wamid.3", "deny approval_0123456789abcdef0123456789abcdef not now"),
        )
      ).status,
    ).toBe(200);
    expect(gateway.decisions).toEqual([
      {
        approvalId: "3f2a9c1e-8b4d-4e6f-9a0b-1c2d3e4f5a6b",
        decision: "allow_once",
        authorId: `whatsapp:${SENDER}`,
      },
      {
        approvalId: "approval_0123456789abcdef0123456789abcdef",
        decision: "deny",
        authorId: `whatsapp:${SENDER}`,
        reason: "not now",
      },
    ]);
    expect(gateway.messages(threadId).map((m) => m.body)).toEqual(["hello"]);
    expect(adapter.counters.approval_decided).toBe(2);

    // Already decided: a notice, no error.
    await adapter.handleWebhook(
      textMessage(SENDER, "wamid.4", "approve 3f2a9c1e-8b4d-4e6f-9a0b-1c2d3e4f5a6b"),
    );
    expect(graph.sends.at(-1)?.body).toMatchObject({
      text: { body: "That approval was already decided." },
    });
  });

  it("refuses an approval from another thread and treats an Always spelling as text", async () => {
    await adapter.handleWebhook(textMessage(SENDER, "wamid.1", "hello"));
    const threadId = gateway.threads()[0]?.id as string;
    gateway.addApproval(approval("7a7a7a7a-0000-4000-8000-000000000001", "thr_someone_else"));
    gateway.addApproval(approval("7a7a7a7a-0000-4000-8000-000000000002", threadId));

    await adapter.handleWebhook(
      textMessage(SENDER, "wamid.2", "approve 7a7a7a7a-0000-4000-8000-000000000001"),
    );
    expect(gateway.decisions).toEqual([]);
    expect(graph.sends.at(-1)?.body).toMatchObject({ text: { body: APPROVAL_REFUSED_NOTICE } });
    expect(adapter.counters.approval_refused).toBe(1);

    await adapter.handleWebhook(
      textMessage(SENDER, "wamid.3", "approve 7a7a7a7a-0000-4000-8000-000000000003"),
    );
    expect(gateway.decisions).toEqual([]);
    expect(adapter.counters.approval_refused).toBe(2);

    await adapter.handleWebhook(
      textMessage(SENDER, "wamid.4", "always 7a7a7a7a-0000-4000-8000-000000000002"),
    );
    expect(gateway.decisions).toEqual([]);
    expect(gateway.messages(threadId).map((m) => m.body)).toEqual([
      "hello",
      "always 7a7a7a7a-0000-4000-8000-000000000002",
    ]);
  });
});
