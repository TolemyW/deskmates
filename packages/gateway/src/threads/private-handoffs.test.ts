import type { BotId, MessageId } from "@deskmates/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildContext } from "../context.js";
import { type GatewayDb, openDatabase } from "../db/open.js";
import type { GatewayEvent } from "../events/bus.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { testConfig } from "../test-support/harness.js";
import { postDirectMessage } from "./direct-messages.js";
import { routePrivateMentions } from "./private-mentions.js";

const databases: GatewayDb[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function setup(budget = 8) {
  const db = openDatabase(":memory:");
  databases.push(db);
  const ctx = buildContext(testConfig(), db, new FakeProvider(), () => "http://gateway.test");
  const ws = ctx.workspaces.create({ name: "team", sandboxProvider: "docker" });
  const alice = ctx.bots.create({
    name: "alice",
    workspaceId: ws.id,
    role: "research",
    messageAllowlist: ["chief"],
  });
  const chief = ctx.bots.create({ name: "chief", workspaceId: ws.id, role: "review" });
  const chat = ctx.threads.create({ workspaceId: ws.id, botIds: [alice.id], turnBudget: budget });
  const run = ctx.router.postHuman({ threadId: chat.id, body: "Review the conclusion" }).runs[0];
  if (!run) throw new Error("missing run");
  ctx.runs.transition(run.id, "running");
  return { db, ctx, ws, alice, chief, chat, run };
}

describe("private-chat handoffs (ADR-0024)", () => {
  it("routes the screenshot case once, preserves membership and shows a reminder outside model messages", () => {
    const { ctx, chief, chat, run } = setup();
    const source = ctx.router.postFromRun(run, "Done. @chief please review. @CHIEF", [
      { name: "brief", mimeType: "text/plain", ref: "/work/brief.md" },
    ]);
    const inbox = ctx.privateChats.resolve(chief.id);
    const notices = ctx.privateChats.list(inbox.id, "user:one");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      callerName: "alice",
      sourceThreadId: chat.id,
      sourceMessageId: source.id,
      status: "queued",
      unread: true,
    });
    expect(ctx.threads.members(chat.id)).toHaveLength(1);
    expect(ctx.threads.members(inbox.id).map((m) => m.botId)).toEqual([chief.id]);
    expect(ctx.messages.list(inbox.id)).toEqual([]);
    expect(ctx.runs.list({ threadId: inbox.id })).toEqual([]);
    const jobs = ctx.runs.list({ botId: chief.id });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ lane: "background", config: { privateHandoffVersion: 1 } });
    const busMessage = ctx.messages.mustGet(jobs[0]?.triggerRef as MessageId);
    expect(busMessage).toMatchObject({
      body: source.body,
      attachments: source.attachments,
      relayCount: source.relayCount,
    });
    routePrivateMentions(ctx, run, source);
    expect(ctx.privateChats.list(inbox.id, "user:one")).toHaveLength(1);
    expect(ctx.messages.list(busMessage.threadId)).toHaveLength(1);
  });

  it("tracks multiple coalesced requests through the single actual run and scopes read state by operator", () => {
    const { ctx, chief, run } = setup();
    ctx.router.postFromRun(run, "@chief first request");
    const inbox = ctx.privateChats.resolve(chief.id);
    const first = ctx.privateChats.list(inbox.id, "user:one")[0];
    if (!first) throw new Error("missing notice");
    ctx.router.postFromRun(run, "@chief second request");
    ctx.privateChats.markRead(inbox.id, "user:one", first.seq);
    expect(ctx.privateChats.unread(inbox.id, "user:one")).toBe(1);
    expect(ctx.privateChats.unread(inbox.id, "user:two")).toBe(2);
    const notices = ctx.privateChats.list(inbox.id, "user:one");
    expect(new Set(notices.map((n) => n.runId)).size).toBe(1);
    const events: GatewayEvent[] = [];
    ctx.bus.subscribe((e) => events.push(e));
    const running = ctx.runs.transition(first.runId, "running");
    ctx.bus.publish({ type: "run_status", threadId: first.handoffThreadId, run: running });
    expect(events).toContainEqual({ type: "thread_activity", threadId: inbox.id });
    expect(ctx.privateChats.list(inbox.id, "user:one").every((n) => n.status === "running")).toBe(
      true,
    );
    ctx.runs.transition(first.runId, "failed", { error: "fixture failure" });
    expect(ctx.privateChats.list(inbox.id, "user:one").every((n) => n.status === "failed")).toBe(
      true,
    );
  });

  it("adopts an existing web private chat once, retains history and creates a fresh inbox after human group promotion", () => {
    const { ctx, ws, chief, alice } = setup();
    const old = ctx.threads.create({ workspaceId: ws.id, botIds: [chief.id] });
    const history = ctx.messages.append({
      threadId: old.id,
      authorKind: "human",
      authorId: "web",
      body: "old notes",
    });
    ctx.threads.create({ workspaceId: ws.id, botIds: [chief.id], channel: "whatsapp" });
    expect(ctx.privateChats.resolve(chief.id).id).toBe(old.id);
    const other = ctx.threads.create({ workspaceId: ws.id, botIds: [chief.id] });
    ctx.threads.touch(other.id);
    expect(ctx.privateChats.resolve(chief.id).id).toBe(old.id);
    ctx.threads.addMember(old.id, alice.id);
    const fresh = ctx.privateChats.resolve(chief.id);
    expect(fresh.id).not.toBe(old.id);
    expect(fresh.id).not.toBe(other.id);
    expect(ctx.messages.mustGet(history.id).body).toBe("old notes");
    expect(ctx.privateChats.resolve(chief.id).id).toBe(fresh.id);
  });

  it("diagnoses unknown, cross-workspace and unconfigured names without creating work", () => {
    const { ctx, ws, run, chat, chief } = setup();
    ctx.bots.create({ name: "other", workspaceId: ws.id, role: "other" });
    const outside = ctx.workspaces.create({ name: "outside", sandboxProvider: "docker" });
    ctx.bots.create({ name: "remote", workspaceId: outside.id, role: "remote" });
    ctx.router.postFromRun(run, "@missing @remote @other @alice");
    expect(ctx.runs.list({ botId: chief.id })).toEqual([]);
    expect(ctx.threads.list().filter((t) => t.kind === "bus")).toEqual([]);
    const diagnostics = ctx.messages.list(chat.id).filter((m) => m.authorKind === "system");
    expect(diagnostics).toHaveLength(3);
    expect(diagnostics.map((m) => m.body)).toContain(
      "@remote was not delivered: no bot with this name exists in this workspace.",
    );
  });

  it("posts no diagnostic when the bot addresses the person as @user (ADR-0024 amendment 3)", () => {
    const { ctx, chief, run, chat } = setup();
    ctx.router.postFromRun(run, "@user done, the report is above.");
    expect(ctx.runs.list({ botId: chief.id })).toEqual([]);
    expect(ctx.messages.list(chat.id).filter((m) => m.authorKind === "system")).toEqual([]);
  });

  it.each(["budget", "paused", "relay"])("does not bypass the source %s limit", (limit) => {
    const { ctx, chief, run, chat, ws } = setup();
    // The turn budget is off by default (ADR-0005 amendment 5 decision 42); a workspace turns it on.
    if (limit === "budget") ctx.limits.set(ws.id, { turnBudget: 1 }, "user:admin");
    if (limit === "paused") ctx.threads.setStatus(chat.id, "paused");
    const trigger =
      limit === "relay"
        ? ctx.messages.append({
            threadId: chat.id,
            authorKind: "bot",
            authorId: chief.id,
            body: "end of chain",
            relayCount: 5,
          })
        : undefined;
    ctx.router.postFromRun(trigger ? { ...run, triggerRef: trigger.id } : run, "@chief check");
    expect(ctx.runs.list({ botId: chief.id })).toEqual([]);
    expect(
      ctx.messages
        .list(chat.id)
        .some((m) => m.authorKind === "system" && m.body.includes("not delivered")),
    ).toBe(true);
  });

  it("does not report delivery when the destination bus is paused, even if an older wake exists", () => {
    const { ctx, chief, run, chat } = setup();
    const first = postDirectMessage(ctx, run, "chief", "first", []);
    ctx.threads.setStatus(first.message.threadId, "paused");
    ctx.router.postFromRun(run, "@chief another request");
    expect(ctx.privateChats.list(ctx.privateChats.resolve(chief.id).id, "web")).toHaveLength(1);
    expect(ctx.messages.list(chat.id).at(-1)?.body).toContain("was not delivered");
  });

  it("preserves group, bus and external-channel member-only mention behavior", () => {
    const { ctx, ws, alice, chief } = setup();
    const peer = ctx.bots.create({ name: "peer", workspaceId: ws.id, role: "peer" });
    for (const opts of [
      { botIds: [alice.id, peer.id] },
      { botIds: [alice.id], kind: "bus" as const },
      { botIds: [alice.id], channel: "whatsapp" },
    ]) {
      const thread = ctx.threads.create({ workspaceId: ws.id, ...opts });
      const run = ctx.runs.create({
        botId: alice.id,
        threadId: thread.id,
        lane: "interactive",
        triggerKind: "cron",
        triggerRef: "test",
      });
      ctx.router.postFromRun(run, "@chief check");
    }
    expect(ctx.runs.list({ botId: chief.id })).toEqual([]);
  });

  it("rolls back the source, handoff, reminder and publications together on storage failure", () => {
    const { ctx, run, chat, chief } = setup();
    const events: GatewayEvent[] = [];
    ctx.bus.subscribe((e) => events.push(e));
    vi.spyOn(ctx.privateChats, "recordResult").mockImplementationOnce(() => {
      throw new Error("storage failure");
    });
    expect(() => ctx.router.postFromRun(run, "@chief check")).toThrow("storage failure");
    expect(ctx.messages.list(chat.id)).toHaveLength(1);
    expect(ctx.runs.list({ botId: chief.id })).toEqual([]);
    expect(events).toEqual([]);
  });

  it("keeps HTTP replay deduplication and reminders through a context restart", () => {
    const { ctx, db, run, chief } = setup();
    const post = () => ctx.router.postFromRun(run, "@chief check");
    const one = ctx.bus.batch(() =>
      ctx.privateChats.postOnce(run.id, "request-1", "same body", post),
    );
    const restarted = buildContext(
      testConfig(),
      db,
      new FakeProvider(),
      () => "http://gateway.test",
    );
    const two = restarted.privateChats.postOnce(run.id, "request-1", "same body", () => {
      throw new Error("must not repost");
    });
    expect(two).toEqual(one);
    expect(
      restarted.privateChats.list(restarted.privateChats.resolve(chief.id).id, "web"),
    ).toHaveLength(1);
    expect(() =>
      restarted.privateChats.postOnce(run.id, "request-1", "different body", post),
    ).toThrow("different content");
  });
});
