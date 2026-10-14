import { APPROVAL_ATTACHMENT_MIME, type Approval } from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeGateway, startFakeGateway } from "../test-support/fake-gateway.js";
import { WhatsAppAdapter } from "../whatsapp/adapter.js";
import { GatewayClient } from "../whatsapp/gateway-client.js";
import { MemoryStateStore } from "../whatsapp/state.js";
import type { InboundText } from "../whatsapp/webhook-payload.js";

const ACCOUNT = "15550001111";
const SENDER = "15550002222";
let gateway: FakeGateway;
let adapter: WhatsAppAdapter;
let sends: { to: string; text: string }[];
const event = (text: string, id = "m1", from = SENDER): InboundText => ({
  kind: "text",
  text,
  id: `web:${ACCOUNT}:${id}`,
  from,
  phoneNumberId: `web:${ACCOUNT}`,
  timestamp: "1",
});
beforeEach(async () => {
  gateway = await startFakeGateway();
  gateway.addBot("bot_test", "Helper");
  sends = [];
  adapter = new WhatsAppAdapter({
    config: {
      phoneNumberId: `web:${ACCOUNT}`,
      allowedSenders: new Set([SENDER]),
      workspaceId: "ws_test",
      botIds: ["bot_test"],
    },
    gateway: new GatewayClient({ baseUrl: gateway.baseUrl, operatorToken: gateway.token }),
    state: new MemoryStateStore(),
    log: { info: () => {}, warn: () => {} },
    send: async (to, text) => {
      sends.push({ to, text });
      return { ok: true, messageId: `sent${sends.length}`, attempts: 1 };
    },
  });
});
afterEach(async () => {
  await adapter.stop();
  await gateway.close();
});

describe("QR transport using Gateway channel semantics", () => {
  it("binds by linked account and deduplicates a repeated WhatsApp message ID", async () => {
    await adapter.handleInbound(event("hi"));
    await adapter.handleInbound(event("hi"));
    const thread = gateway.threads()[0];
    expect(thread?.externalKey).toBe(`web:${ACCOUNT}:${SENDER}`);
    expect(gateway.messages(thread?.id ?? "")).toHaveLength(1);
    expect(adapter.counters.inbound_duplicate).toBe(1);
    expect(gateway.messages(thread?.id ?? "")[0]?.authorId).toBe(`whatsapp:${SENDER}`);
  });
  it("drops unlisted senders and another linked account before creating a thread", async () => {
    await adapter.handleInbound(event("stranger", "m2", "15550009999"));
    await adapter.handleInbound({ ...event("wrong account"), phoneNumberId: "web:15550003333" });
    expect(gateway.threads()).toHaveLength(0);
    expect(sends).toHaveLength(0);
  });
  it("relays bot replies and approval instructions without echoing the human command", async () => {
    await adapter.handleInbound(event("hello"));
    const thread = gateway.threads()[0];
    if (!thread) throw new Error("No thread");
    gateway.append(thread.id, { authorKind: "bot", authorId: "bot_test", body: "done" });
    gateway.append(thread.id, {
      authorKind: "system",
      authorId: "system",
      body: "Please approve",
      attachments: [
        {
          name: "approval",
          mimeType: APPROVAL_ATTACHMENT_MIME,
          ref: "approval_0123456789abcdef0123456789abcdef",
        },
      ],
    });
    await adapter.relay(thread.id);
    expect(sends.map((send) => send.text)).toEqual([
      "Helper: done",
      expect.stringContaining("approve approval_0123456789abcdef0123456789abcdef"),
    ]);
    expect(sends.every((send) => send.to === SENDER)).toBe(true);
  });
  it("allows only approval decisions for the sender's own conversation", async () => {
    await adapter.handleInbound(event("hello"));
    const thread = gateway.threads()[0];
    if (!thread) throw new Error("No thread");
    const approval: Approval = {
      id: "approval_0123456789abcdef0123456789abcdef" as Approval["id"],
      runId: "run_test" as Approval["runId"],
      botId: "bot_test" as Approval["botId"],
      threadId: thread.id,
      createdAt: new Date().toISOString() as Approval["createdAt"],
      riskLevel: "L2",
      action: { toolName: "Bash", input: { command: "echo test" } },
      waitMode: "live",
    };
    gateway.addApproval(approval);
    await adapter.handleInbound(event("approve approval_0123456789abcdef0123456789abcdef", "m2"));
    expect(gateway.decisions).toMatchObject([
      {
        approvalId: "approval_0123456789abcdef0123456789abcdef",
        decision: "allow_once",
        authorId: `whatsapp:${SENDER}`,
      },
    ]);
    expect(gateway.messages(thread.id)).toHaveLength(1);
    gateway.addApproval({
      ...approval,
      id: "approval_fedcba9876543210fedcba9876543210" as Approval["id"],
      threadId: "thr_other" as NonNullable<Approval["threadId"]>,
    });
    await adapter.handleInbound(event("approve approval_fedcba9876543210fedcba9876543210", "m3"));
    expect(gateway.decisions).toHaveLength(1);
    expect(adapter.counters.approval_refused).toBe(1);
  });
});
