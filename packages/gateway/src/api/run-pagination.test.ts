// #113 slice R: the run list is a keyset page, newest first, with every unfinished run listed
// whole through `phase=active`; run events are a bounded newest window with Load older or a
// bounded tail; two summary routes replace tenant-wide run reads. Limits above the maximum and
// cursors of another scope are refused.

import type { BotId, RunId, ThreadId, WorkspaceId } from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGateway, buildOperatorGateway } from "../index.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { TEST_OPERATOR_TOKEN, testConfig } from "../test-support/harness.js";

const human = { authorization: `Bearer ${TEST_OPERATOR_TOKEN}` };
let sandbox: ReturnType<typeof buildGateway>;
let operator: ReturnType<typeof buildOperatorGateway>;
let workspaceId: WorkspaceId;
let botId: BotId;
let otherBotId: BotId;
let threadId: ThreadId;

beforeEach(async () => {
  sandbox = buildGateway(testConfig(), new FakeProvider(), { startCron: false });
  operator = buildOperatorGateway(sandbox.deskmates);
  await Promise.all([sandbox.ready(), operator.ready()]);
  sandbox.deskmates.scheduler.stop();
  const ctx = sandbox.deskmates.ctx;
  workspaceId = ctx.workspaces.create({ name: "runs", sandboxProvider: "docker" }).id;
  botId = ctx.bots.create({ workspaceId, name: "alpha", role: "r" }).id;
  otherBotId = ctx.bots.create({ workspaceId, name: "beta", role: "r" }).id;
  threadId = ctx.threads.create({ workspaceId, botIds: [botId] }).id;
});
afterEach(async () => {
  await operator.close();
  await sandbox.close();
});

/** `count` runs of `bot` in the thread; every run shares one timestamp per pair of runs. */
function seedRuns(
  count: number,
  opts: { bot?: BotId; status?: string; config?: Record<string, unknown> } = {},
): RunId[] {
  const ctx = sandbox.deskmates.ctx;
  const ids: RunId[] = [];
  for (let i = 0; i < count; i += 1) {
    const run = ctx.runs.create({
      botId: opts.bot ?? botId,
      threadId,
      lane: "interactive",
      triggerKind: "thread_message",
      triggerRef: `msg_${i}`,
      ...(opts.config ? { config: opts.config } : {}),
    });
    // Equal timestamps in pairs, so the id tie-breaker decides the order inside each pair.
    const at = new Date(Date.UTC(2026, 9, 13, 0, 0, Math.floor(i / 2))).toISOString();
    ctx.db
      .prepare("UPDATE runs SET created_at = ?, status = ? WHERE id = ?")
      .run(at, opts.status ?? "succeeded", run.id);
    ids.push(run.id);
  }
  return ids;
}

async function get(url: string) {
  return operator.inject({ method: "GET", url, headers: human });
}

describe("run pagination (#113 R)", () => {
  it("pages a thread's runs newest first across three pages with a stable tie-breaker", async () => {
    const ids = seedRuns(45);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const url = `/api/runs?threadId=${threadId}&limit=20${cursor ? `&cursor=${cursor}` : ""}`;
      const body = (await get(url)).json();
      seen.push(...body.runs.map((r: { id: string }) => r.id));
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(45);
    expect(new Set(seen).size).toBe(45);
    const expected = sandbox.deskmates.ctx.runs
      .list({ threadId })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .map((r) => r.id);
    expect(seen).toEqual(expected);
    expect(expected.sort()).toEqual([...ids].sort());
  });

  it("defaults to 20 and ends with an empty last page when the count divides evenly", async () => {
    seedRuns(40);
    const first = (await get(`/api/runs?botId=${botId}`)).json();
    expect(first.runs).toHaveLength(20);
    const second = (await get(`/api/runs?botId=${botId}&cursor=${first.nextCursor}`)).json();
    expect(second.runs).toHaveLength(20);
    expect(second.nextCursor).toBeUndefined();
  });

  it("lists unfinished runs whole and keeps them out of the finished pages", async () => {
    seedRuns(25, { status: "succeeded" });
    seedRuns(3, { status: "waiting_approval" });
    const active = (await get(`/api/runs?threadId=${threadId}&phase=active`)).json();
    expect(active.runs).toHaveLength(3);
    expect(active.nextCursor).toBeUndefined();
    const finished = (await get(`/api/runs?threadId=${threadId}&phase=finished&limit=100`)).json();
    expect(finished.runs).toHaveLength(25);
    // Without a phase the first page carries the live runs too; the cursor walks finished ones.
    const first = (await get(`/api/runs?threadId=${threadId}`)).json();
    expect(first.runs).toHaveLength(23);
    expect(first.runs.slice(0, 3).map((r: { status: string }) => r.status)).toEqual([
      "waiting_approval",
      "waiting_approval",
      "waiting_approval",
    ]);
    const next = (await get(`/api/runs?threadId=${threadId}&cursor=${first.nextCursor}`)).json();
    expect(next.runs).toHaveLength(5);
    expect(next.runs.every((r: { status: string }) => r.status === "succeeded")).toBe(true);
    expect(next.nextCursor).toBeUndefined();
    expect((await get(`/api/runs?threadId=${threadId}&phase=active&limit=5`)).statusCode).toBe(400);
    expect((await get(`/api/runs?threadId=${threadId}&phase=later`)).statusCode).toBe(400);
  });

  it("refuses a limit over the maximum and a cursor from another scope", async () => {
    seedRuns(30);
    expect((await get(`/api/runs?threadId=${threadId}&limit=101`)).statusCode).toBe(400);
    expect((await get(`/api/runs?threadId=${threadId}&limit=0`)).statusCode).toBe(400);
    const page = (await get(`/api/runs?threadId=${threadId}&limit=10`)).json();
    const foreign = await get(`/api/runs?botId=${botId}&limit=10&cursor=${page.nextCursor}`);
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json()).toMatchObject({ code: "validation", details: { field: "cursor" } });
    expect((await get(`/api/runs?threadId=${threadId}&cursor=garbage`)).statusCode).toBe(400);
  });

  it("summarizes each bot's newest run and the newest memory index observation", async () => {
    seedRuns(5, { bot: botId });
    const counts = { considered: 4, pinned: 1, untrusted: 0, budget: 3, ineligible: 0 };
    const [observed] = seedRuns(1, { bot: otherBotId, config: { memory: { counts } } });
    seedRuns(2, { bot: otherBotId });
    const latest = (await get(`/api/runs/latest-by-bot?workspaceId=${workspaceId}`)).json();
    const all = sandbox.deskmates.ctx.runs.list({});
    const newest = (bot: BotId) =>
      all
        .filter((r) => r.botId === bot)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0]?.id;
    expect(latest.runs.map((r: { botId: string; id: string }) => [r.botId, r.id])).toEqual([
      [botId, newest(botId)],
      [otherBotId, newest(otherBotId)],
    ]);
    const index = (await get(`/api/runs/memory-index?workspaceId=${workspaceId}`)).json();
    expect(index).toEqual({ observation: { runId: observed, counts } });
    expect((await get("/api/runs/latest-by-bot")).statusCode).toBe(400);
  });
});

describe("run event slices (#113 R)", () => {
  function seedEvents(count: number): RunId {
    const [runId] = seedRuns(1) as [RunId];
    const events = sandbox.deskmates.ctx.events;
    for (let i = 0; i < count; i += 1) events.append({ runId, kind: "log", payload: { line: i } });
    return runId;
  }

  it("returns the newest window and loads older events before it", async () => {
    const runId = seedEvents(450);
    const first = (await get(`/api/runs/${runId}/events`)).json();
    expect(first.events).toHaveLength(200);
    expect(first.hasOlder).toBe(true);
    expect(first.events.at(-1).seq).toBe(450);
    const seqs: number[] = first.events.map((e: { seq: number }) => e.seq);
    let before = seqs[0];
    let older = true;
    while (older) {
      const page = (await get(`/api/runs/${runId}/events?beforeSeq=${before}`)).json();
      seqs.unshift(...page.events.map((e: { seq: number }) => e.seq));
      before = page.events[0]?.seq;
      older = page.hasOlder;
    }
    expect(seqs).toEqual(Array.from({ length: 450 }, (_, i) => i + 1));
  });

  it("bounds a tail and says when there is more", async () => {
    const runId = seedEvents(30);
    const tail = (await get(`/api/runs/${runId}/events?afterSeq=10&limit=15`)).json();
    expect(tail.events.map((e: { seq: number }) => e.seq)).toEqual(
      Array.from({ length: 15 }, (_, i) => i + 11),
    );
    expect(tail.hasMore).toBe(true);
    const rest = (await get(`/api/runs/${runId}/events?afterSeq=25`)).json();
    expect(rest).toMatchObject({ hasMore: false });
    expect(rest.events).toHaveLength(5);
    expect((await get(`/api/runs/${runId}/events?afterSeq=30`)).json()).toEqual({
      events: [],
      hasMore: false,
    });
    expect((await get(`/api/runs/${runId}/events?limit=501`)).statusCode).toBe(400);
    expect((await get(`/api/runs/${runId}/events?afterSeq=1&beforeSeq=5`)).statusCode).toBe(400);
    expect((await get(`/api/runs/${runId}/events?afterSeq=-1`)).statusCode).toBe(400);
  });
});
