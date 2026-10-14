// #113 slice CH: a transcript is a newest window with Load older or a bounded tail, a private
// chat's incoming handoffs are a newest-first keyset page, and a workspace's chat rail is a
// keyset page whose first page also holds its pins and inboxes. Limits above the maximum and
// cursors of another thread or search are refused.

import type { BotId, MessageId, RunId, ThreadId, WorkspaceId } from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGateway, buildOperatorGateway } from "../index.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { TEST_OPERATOR_TOKEN, testConfig } from "../test-support/harness.js";

const human = { authorization: `Bearer ${TEST_OPERATOR_TOKEN}` };
let sandbox: ReturnType<typeof buildGateway>;
let operator: ReturnType<typeof buildOperatorGateway>;
let workspaceId: WorkspaceId;
let botId: BotId;
let callerId: BotId;
let threadId: ThreadId;

beforeEach(async () => {
  sandbox = buildGateway(testConfig(), new FakeProvider(), { startCron: false });
  operator = buildOperatorGateway(sandbox.deskmates);
  await Promise.all([sandbox.ready(), operator.ready()]);
  sandbox.deskmates.scheduler.stop();
  const ctx = sandbox.deskmates.ctx;
  workspaceId = ctx.workspaces.create({ name: "chats", sandboxProvider: "docker" }).id;
  botId = ctx.bots.create({ workspaceId, name: "alpha", role: "r" }).id;
  callerId = ctx.bots.create({ workspaceId, name: "beta", role: "r" }).id;
  threadId = ctx.threads.create({ workspaceId, botIds: [botId] }).id;
});
afterEach(async () => {
  await operator.close();
  await sandbox.close();
});

function seedMessages(thread: ThreadId, count: number): void {
  for (let i = 1; i <= count; i += 1)
    sandbox.deskmates.ctx.messages.append({
      threadId: thread,
      authorKind: "human",
      authorId: "op",
      body: `m${i}`,
    });
}

async function get(url: string) {
  return operator.inject({ method: "GET", url, headers: human });
}

const seqs = (body: { messages: { seq: number }[] }) => body.messages.map((m) => m.seq);

describe("transcript slices (#113 CH)", () => {
  it("opens on the newest 50 and walks older windows back to the first message", async () => {
    seedMessages(threadId, 130);
    const first = (await get(`/api/threads/${threadId}/messages`)).json();
    expect(seqs(first)).toEqual(Array.from({ length: 50 }, (_, i) => i + 81));
    expect(first.hasOlder).toBe(true);
    const all = seqs(first);
    let body = first;
    while (body.hasOlder) {
      body = (await get(`/api/threads/${threadId}/messages?beforeSeq=${all[0]}`)).json();
      all.unshift(...seqs(body));
    }
    expect(all).toEqual(Array.from({ length: 130 }, (_, i) => i + 1));
  });

  it("bounds a tail and reports an empty last slice", async () => {
    seedMessages(threadId, 30);
    const tail = (await get(`/api/threads/${threadId}/messages?afterSeq=5&limit=20`)).json();
    expect(seqs(tail)).toEqual(Array.from({ length: 20 }, (_, i) => i + 6));
    expect(tail.hasMore).toBe(true);
    const rest = (await get(`/api/threads/${threadId}/messages?afterSeq=25`)).json();
    expect(rest).toMatchObject({ hasMore: false });
    expect((await get(`/api/threads/${threadId}/messages?afterSeq=30`)).json()).toEqual({
      messages: [],
      hasMore: false,
    });
  });

  it("refuses a limit over the maximum and contradictory bounds", async () => {
    seedMessages(threadId, 3);
    expect((await get(`/api/threads/${threadId}/messages?limit=201`)).statusCode).toBe(400);
    expect((await get(`/api/threads/${threadId}/messages?afterSeq=1&beforeSeq=3`)).statusCode).toBe(
      400,
    );
    expect((await get(`/api/threads/${threadId}/messages?beforeSeq=x`)).statusCode).toBe(400);
  });
});

describe("incoming handoff feed (#113 CH)", () => {
  function seedHandoffs(count: number): ThreadId {
    const ctx = sandbox.deskmates.ctx;
    const inbox = ctx.privateChats.resolve(botId).id;
    const bus = ctx.threads.create({ workspaceId, botIds: [callerId, botId], kind: "bus" }).id;
    for (let i = 0; i < count; i += 1) {
      const source = ctx.messages.append({
        threadId: inbox,
        authorKind: "human",
        authorId: "op",
        body: `ask ${i}`,
      });
      const handoff = ctx.messages.append({
        threadId: bus,
        authorKind: "bot",
        authorId: callerId,
        body: `please ${i}`,
      });
      const run = ctx.runs.create({
        botId,
        threadId: bus,
        lane: "background",
        triggerKind: "thread_message",
        triggerRef: handoff.id,
      });
      ctx.privateChats.record(
        handoff.id as MessageId,
        source.id as MessageId,
        botId,
        run.id as RunId,
      );
    }
    return inbox;
  }

  it("pages handoffs newest first and refuses a cursor of another thread", async () => {
    const inbox = seedHandoffs(45);
    const seen: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const body = (
        await get(`/api/threads/${inbox}/activity${cursor ? `?cursor=${cursor}` : ""}`)
      ).json();
      seen.push(...body.handoffs.map((h: { seq: number }) => h.seq));
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(45);
    expect(seen).toEqual([...seen].sort((a, b) => b - a));
    const page = (await get(`/api/threads/${inbox}/activity?limit=5`)).json();
    const other = sandbox.deskmates.ctx.threads.create({ workspaceId, botIds: [callerId] }).id;
    const foreign = await get(`/api/threads/${other}/activity?cursor=${page.nextCursor}`);
    expect(foreign.statusCode).toBe(400);
    expect((await get(`/api/threads/${inbox}/activity?limit=101`)).statusCode).toBe(400);
  });
});

describe("chat rail page (#113 CH)", () => {
  it("puts pins and inboxes on the first page and pages the rest by recency", async () => {
    const ctx = sandbox.deskmates.ctx;
    const inbox = ctx.privateChats.resolve(botId).id;
    const groups: ThreadId[] = [];
    for (let i = 0; i < 120; i += 1) {
      const id = ctx.threads.create({
        workspaceId,
        botIds: [botId, callerId],
        title: `group ${String(i).padStart(3, "0")}`,
      }).id;
      // Equal timestamps in pairs, so the id tie-breaker orders each pair.
      const at = new Date(Date.UTC(2026, 9, 14, 0, 0, Math.floor(i / 2))).toISOString();
      ctx.db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(at, id);
      groups.push(id);
    }
    const pinned = groups[3] as ThreadId;
    ctx.threadPins.pin(pinned, "op");
    const ids: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const url = `/api/threads?workspaceId=${workspaceId}&limit=50${cursor ? `&cursor=${cursor}` : ""}`;
      const body = (await get(url)).json();
      ids.push(...body.threads.map((t: { id: string }) => t.id));
      if (pages === 0) {
        expect(body.threads.map((t: { id: string }) => t.id).slice(0, 3)).toEqual(
          expect.arrayContaining([inbox, pinned]),
        );
      }
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    // Every thread once: the inbox, the pin and the 119 other groups.
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(new Set([threadId, inbox, ...groups]));
    const rest = ids.filter((id) => id !== inbox && id !== pinned && id !== threadId);
    const expected = ctx.threads
      .list(workspaceId)
      .filter((t) => groups.includes(t.id) && t.id !== pinned)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
      .map((t) => t.id);
    expect(rest).toEqual(expected);
  });

  it("searches titles and member names on the server and refuses a cursor of another search", async () => {
    const ctx = sandbox.deskmates.ctx;
    for (let i = 0; i < 12; i += 1)
      ctx.threads.create({ workspaceId, botIds: [botId, callerId], title: `launch ${i}` });
    const body = (await get(`/api/threads?workspaceId=${workspaceId}&q=LAUNCH&limit=5`)).json();
    expect(body.threads).toHaveLength(5);
    expect(body.threads.every((t: { title: string }) => t.title.startsWith("launch"))).toBe(true);
    const byMember = (await get(`/api/threads?workspaceId=${workspaceId}&q=beta`)).json();
    expect(byMember.threads).toHaveLength(12);
    const other = await get(
      `/api/threads?workspaceId=${workspaceId}&q=other&cursor=${body.nextCursor}`,
    );
    expect(other.statusCode).toBe(400);
    expect((await get(`/api/threads?workspaceId=${workspaceId}&limit=101`)).statusCode).toBe(400);
    expect((await get("/api/threads?limit=10")).statusCode).toBe(400);
    // Unpaged, the list stays whole for the lookups that read it.
    expect((await get(`/api/threads?workspaceId=${workspaceId}`)).json().threads).toHaveLength(13);
  });
});
