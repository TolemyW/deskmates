import { THREAD_LINK_ATTACHMENT_MIME } from "@deskmates/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildContext } from "../context.js";
import { type GatewayDb, openDatabase } from "../db/open.js";
import type { GatewayEvent } from "../events/bus.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { testConfig } from "../test-support/harness.js";
import { postDirectMessage } from "./direct-messages.js";

const databases: GatewayDb[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function setup() {
  const db = openDatabase(":memory:");
  databases.push(db);
  const ctx = buildContext(testConfig(), db, new FakeProvider(), () => "http://gateway.test");
  const ws = ctx.workspaces.create({ name: "qa", sandboxProvider: "docker" });
  const alice = ctx.bots.create({
    name: "alice",
    role: "owner",
    workspaceId: ws.id,
    messageAllowlist: ["bob"],
  });
  const bob = ctx.bots.create({
    name: "bob",
    role: "reviewer",
    workspaceId: ws.id,
    messageAllowlist: ["alice"],
  });
  const chat = ctx.threads.create({ workspaceId: ws.id, botIds: [alice.id] });
  const trigger = ctx.messages.append({
    threadId: chat.id,
    authorKind: "human",
    authorId: "web",
    body: "Review this",
  });
  const run = ctx.runs.create({
    botId: alice.id,
    threadId: chat.id,
    lane: "interactive",
    triggerKind: "thread_message",
    triggerRef: trigger.id,
  });
  return { ctx, ws, alice, bob, chat, run };
}

describe("message_bot pairwise bus routing", () => {
  it("creates a target-only background wake and a linked handoff without waking the chat", () => {
    const { ctx, alice, bob, chat, run } = setup();
    const attachments = [{ name: "report", mimeType: "text/plain", ref: "/work/report.txt" }];
    const result = postDirectMessage(ctx, run, "BOB", "Please review", attachments);
    expect(ctx.threads.mustGet(result.message.threadId).kind).toBe("bus");
    expect(ctx.threads.members(result.message.threadId).map((m) => m.botId)).toEqual([
      alice.id,
      bob.id,
    ]);
    expect(result.message).toMatchObject({
      authorId: alice.id,
      runId: run.id,
      relayCount: 1,
      mentions: [{ kind: "bot", botId: bob.id }],
      attachments,
    });
    const wakes = ctx.runs.listQueued().filter((r) => r.id !== run.id);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      botId: bob.id,
      threadId: result.message.threadId,
      lane: "background",
      triggerRef: result.message.id,
    });
    expect(result.handoff).toMatchObject({
      threadId: chat.id,
      authorKind: "system",
      runId: run.id,
      attachments: [
        {
          name: "Open conversation",
          mimeType: THREAD_LINK_ATTACHMENT_MIME,
          ref: result.message.threadId,
        },
      ],
    });
    expect(ctx.events.list(run.id).some((e) => e.payload.tool === "message_bot")).toBe(true);
  });

  it("reuses the exact pair in either direction and coalesces repeated recipient wakes", () => {
    const { ctx, bob, run } = setup();
    const first = postDirectMessage(ctx, run, "bob", "One", []).message;
    const second = postDirectMessage(ctx, run, "bob", "Two", []).message;
    expect(second.threadId).toBe(first.threadId);
    const bobRun = ctx.runs.listQueued().find((r) => r.botId === bob.id);
    expect(bobRun).toBeDefined();
    if (!bobRun) throw new Error("missing recipient wake");
    const back = postDirectMessage(ctx, bobRun, "alice", "Review done", []);
    expect(back.message.threadId).toBe(first.threadId);
    expect(back.message.relayCount).toBe(2);
    expect(back.handoff).toBeUndefined();
    expect(ctx.threads.list().filter((t) => t.kind === "bus")).toHaveLength(1);
    expect(ctx.runs.listQueued().filter((r) => r.botId === bob.id)).toHaveLength(1);
  });

  it("works for background triggers that have no human thread", () => {
    const { ctx, alice } = setup();
    const cron = ctx.runs.create({
      botId: alice.id,
      lane: "background",
      triggerKind: "cron",
      triggerRef: "cron:qa",
      triggerPayload: { prompt: "Review" },
    });
    const result = postDirectMessage(ctx, cron, "bob", "Scheduled review", []);
    expect(result.handoff).toBeUndefined();
    expect(result.message).toMatchObject({ runId: cron.id, relayCount: 1 });
  });

  it("stores an over-depth handoff but does not wake the recipient", () => {
    const { ctx, alice, chat } = setup();
    const trigger = ctx.messages.append({
      threadId: chat.id,
      authorKind: "bot",
      authorId: alice.id,
      body: "chain",
      relayCount: 5,
    });
    const run = ctx.runs.create({
      botId: alice.id,
      threadId: chat.id,
      lane: "interactive",
      triggerKind: "thread_message",
      triggerRef: trigger.id,
    });
    const before = ctx.runs.listQueued().length;
    const result = postDirectMessage(ctx, run, "bob", "Too deep", []);
    expect(result.message.relayCount).toBe(6);
    expect(ctx.runs.listQueued()).toHaveLength(before);
    expect(ctx.events.list(run.id).some((e) => e.kind === "cap_breached")).toBe(true);
  });

  it("rejects unknown, self, unconfigured and cross-workspace targets without partial writes", () => {
    const { ctx, ws, run, chat } = setup();
    ctx.bots.create({ name: "other", role: "other", workspaceId: ws.id });
    const otherWs = ctx.workspaces.create({ name: "separate", sandboxProvider: "docker" });
    ctx.bots.create({ name: "remote", role: "other", workspaceId: otherWs.id });
    for (const to of ["missing", "alice", "other", "remote"]) {
      expect(() => postDirectMessage(ctx, run, to, "hello", [])).toThrow();
    }
    expect(ctx.threads.list().filter((t) => t.kind === "bus")).toEqual([]);
    expect(ctx.messages.list(chat.id)).toHaveLength(1);
  });

  it("rolls back bus creation when the message body is invalid", () => {
    const { ctx, run } = setup();
    expect(() => postDirectMessage(ctx, run, "bob", "  ", [])).toThrow();
    expect(ctx.threads.list().filter((t) => t.kind === "bus")).toEqual([]);
  });

  it("publishes committed transcript rows before wakes and emits nothing if the transaction fails", () => {
    const { ctx, run, chat } = setup();
    const seen: GatewayEvent[] = [];
    const publishedInTransaction: boolean[] = [];
    ctx.bus.subscribe((event) => {
      publishedInTransaction.push(ctx.db.inTransaction);
      seen.push(event);
    });
    const append = ctx.events.append.bind(ctx.events);
    const fault = vi.spyOn(ctx.events, "append").mockImplementationOnce((input) => {
      append(input);
      throw new Error("injected transaction failure after ledger append");
    });
    expect(() => postDirectMessage(ctx, run, "bob", "hello", [])).toThrow("injected");
    fault.mockRestore();
    expect(seen).toEqual([]);
    expect(ctx.threads.list().filter((t) => t.kind === "bus")).toEqual([]);
    expect(ctx.messages.list(chat.id)).toHaveLength(1);
    expect(ctx.runs.listQueued()).toHaveLength(1);
    expect(ctx.events.list(run.id)).toEqual([]);

    const result = postDirectMessage(ctx, run, "bob", "retry", []);
    expect(seen.map((e) => e.type)).toEqual([
      "thread_message",
      "thread_message",
      "thread_activity",
      "run_status",
      "thread_activity",
      "run_event",
    ]);
    expect(publishedInTransaction.every((inside) => !inside)).toBe(true);
    expect(seen[0]).toMatchObject({ threadId: result.message.threadId });
    expect(seen[1]).toMatchObject({ threadId: chat.id });
  });
});
