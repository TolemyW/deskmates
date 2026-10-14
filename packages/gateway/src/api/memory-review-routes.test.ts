// T1 (ADR-0011 amendment 3, A18, A20, A23; #113 slice K2 surfaces 18 to 21): the learned-memory
// lists page with the shared cursor contract, topics filter the entry list, and review groups and
// batch dispositions work over HTTP within one workspace.

import type { MemoryReviewBatch, MemoryReviewGroup, WorkspaceId } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayContext } from "../context.js";
import { writeLearnedItems } from "../memory/learned-writes.js";
import { type Harness, startHarness } from "../test-support/harness.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const SAME_TIME = "2026-10-01T00:00:00.000Z";

function note(ctx: GatewayContext, workspaceId: WorkspaceId, body: string, observedAt?: string) {
  return ctx.memory.entries.insert({
    workspaceId,
    scope: "workspace",
    kind: "note",
    body,
    authority: "fact",
    trust: "trusted",
    sourceKind: "human",
    ...(observedAt ? { observedAt } : {}),
    by: "human:o",
  });
}

async function pages<T>(
  harness: Harness,
  path: string,
  key: string,
): Promise<{ items: T[]; pages: number }> {
  const items: T[] = [];
  let cursor: string | undefined;
  let count = 0;
  do {
    const sep = path.includes("?") ? "&" : "?";
    const res = await harness.api<Record<string, unknown> & { nextCursor?: string }>(
      "GET",
      `${path}${cursor ? `${sep}cursor=${cursor}` : ""}`,
    );
    expect(res.status).toBe(200);
    items.push(...((res.json[key] as T[]) ?? []));
    cursor = res.json.nextCursor;
    count += 1;
  } while (cursor && count < 50);
  return { items, pages: count };
}

async function otherWorkspace(harness: Harness): Promise<WorkspaceId> {
  const res = await harness.api<{ workspace: { id: WorkspaceId } }>("POST", "/api/workspaces", {
    name: "other",
    egressAllowlist: [],
  });
  return res.json.workspace.id;
}

describe("entries (surface 18)", () => {
  it("pages 60 entries with equal timestamps in a stable order, and refuses bad pages", async () => {
    h = await startHarness();
    const { workspace } = await h.seed();
    const ctx = h.app.deskmates.ctx;
    for (let n = 0; n < 60; n += 1)
      note(ctx, workspace.id, `Entry number ${n} is here.`, SAME_TIME);
    const path = `/api/workspaces/${workspace.id}/memory?limit=25`;
    const all = await pages<{ id: string }>(h, path, "entries");
    expect(all.pages).toBe(3);
    expect(new Set(all.items.map((e) => e.id)).size).toBe(60);
    expect(all.items.map((e) => e.id)).toEqual([...all.items.map((e) => e.id)].sort().reverse());
    expect((await h.api("GET", `${path.replace("limit=25", "limit=101")}`)).status).toBe(400);
    // A cursor of another filter (scope) is refused, not reinterpreted.
    const first = await h.api<{ nextCursor: string }>("GET", path);
    const foreign = await h.api(
      "GET",
      `/api/workspaces/${workspace.id}/memory?scope=task&cursor=${first.json.nextCursor}`,
    );
    expect(foreign.status).toBe(400);
  });

  it("filters by topic and counts topics exactly", async () => {
    h = await startHarness();
    const { workspace } = await h.seed();
    const ctx = h.app.deskmates.ctx;
    note(ctx, workspace.id, "VendorDB returns OK for a duplicate-key INSERT.");
    note(ctx, workspace.id, "VendorDB has no window functions.");
    note(ctx, workspace.id, "Invoice export uses semicolons.");
    const forgotten = note(ctx, workspace.id, "Secretproject codename is Bluebird.");
    ctx.memory.entries.tombstone(forgotten.id, "human:o");
    const topics = await h.api<{ topics: { key: string; count: number }[]; total: number }>(
      "GET",
      `/api/workspaces/${workspace.id}/memory/topics`,
    );
    expect(topics.json.topics).toEqual([
      { key: "vendordb", label: "VendorDB", count: 2 },
      { key: "invoice", label: "Invoice", count: 1 },
    ]);
    expect(topics.json.total).toBe(2);
    const vendordb = await h.api<{ entries: { body: string; topic: string }[] }>(
      "GET",
      `/api/workspaces/${workspace.id}/memory?topic=VendorDB`,
    );
    expect(vendordb.json.entries.map((e) => e.topic)).toEqual(["vendordb", "vendordb"]);
    // A forgotten body leaves no topic behind.
    expect(
      ctx.db.prepare("SELECT topic FROM memory_entries WHERE id = ?").get(forgotten.id),
    ).toEqual({ topic: null });
  });
});

describe("search (surface 19)", () => {
  it("refuses a limit over 50 and a cursor of another query", async () => {
    h = await startHarness();
    const { workspace } = await h.seed();
    const ctx = h.app.deskmates.ctx;
    for (let n = 0; n < 25; n += 1) note(ctx, workspace.id, `searchable thing ${n}`);
    const base = `/api/workspaces/${workspace.id}/memory/search`;
    expect((await h.api("GET", `${base}?q=searchable&limit=51`)).status).toBe(400);
    const all = await pages<{ id: string }>(h, `${base}?q=searchable`, "entries");
    expect(all.pages).toBe(2);
    expect(new Set(all.items.map((e) => e.id)).size).toBe(25);
    const first = await h.api<{ nextCursor: string }>("GET", `${base}?q=searchable`);
    expect((await h.api("GET", `${base}?q=thing&cursor=${first.json.nextCursor}`)).status).toBe(
      400,
    );
  });
});

describe("confirmations (surface 20) and review groups", () => {
  function gate(ctx: GatewayContext, botId: string, workspaceId: WorkspaceId, bodies: string[]) {
    for (const body of bodies) {
      const run = ctx.runs.create({
        botId: botId as never,
        lane: "background",
        triggerKind: "cron",
        triggerRef: `gate-${Math.random()}`,
        config: ctx.runConfig(),
      });
      writeLearnedItems(
        ctx.memory.stores,
        { runId: run.id, botId: run.botId, workspaceId, rules: [] },
        [{ body, proposedScope: "workspace", authority: "fact", turn: 1, trust: "trusted" }],
      );
    }
  }

  it("pages 30 pending items with an exact total and refuses limit 101", async () => {
    h = await startHarness();
    const { workspace, bot } = await h.seed();
    const ctx = h.app.deskmates.ctx;
    gate(
      ctx,
      bot.id,
      workspace.id,
      Array.from({ length: 30 }, (_, n) => `Always answer ticket class ${n} first.`),
    );
    ctx.db.prepare("UPDATE memory_suggestions SET created_at = ?").run(SAME_TIME);
    const path = `/api/memory-suggestions?workspaceId=${workspace.id}&status=pending&limit=25`;
    const first = await h.api<{ suggestions: unknown[]; total: number }>("GET", path);
    expect(first.json.total).toBe(30);
    const all = await pages<{ id: string }>(h, path, "suggestions");
    expect(all.pages).toBe(2);
    expect(new Set(all.items.map((s) => s.id)).size).toBe(30);
    expect((await h.api("GET", path.replace("limit=25", "limit=101"))).status).toBe(400);
  });

  it("previews, commits and undoes a batch within one workspace only", async () => {
    h = await startHarness();
    const { workspace, bot } = await h.seed();
    const ctx = h.app.deskmates.ctx;
    gate(ctx, bot.id, workspace.id, [
      "Always reply in French.",
      "always reply in french",
      "Always reply in German.",
    ]);
    const groups = await h.api<{
      groups: MemoryReviewGroup[];
      totalGroups: number;
      totalItems: number;
    }>("GET", `/api/workspaces/${workspace.id}/memory-review/groups`);
    expect([groups.json.totalGroups, groups.json.totalItems]).toEqual([2, 3]);
    const french = groups.json.groups.find((g) => g.count === 2) as MemoryReviewGroup;
    const other = await otherWorkspace(h);
    const foreign = await h.api("POST", `/api/workspaces/${other}/memory-review/preview`, {
      groupKey: french.groupKey,
      decision: "reject",
    });
    expect(foreign.status).toBe(404);
    const preview = await h.api<{ preview: { token: string; itemIds: string[] } }>(
      "POST",
      `/api/workspaces/${workspace.id}/memory-review/preview`,
      { groupKey: french.groupKey, decision: "merge" },
    );
    expect(preview.json.preview.itemIds).toHaveLength(2);
    const committed = await h.api<{ batch: MemoryReviewBatch }>(
      "POST",
      `/api/workspaces/${workspace.id}/memory-review/batches`,
      { groupKey: french.groupKey, decision: "merge", token: preview.json.preview.token },
    );
    expect(committed.status).toBe(200);
    expect(committed.json.batch.entryId).toBeDefined();
    const after = await h.api<{ totalItems: number; batches: MemoryReviewBatch[] }>(
      "GET",
      `/api/workspaces/${workspace.id}/memory-review/groups`,
    );
    expect(after.json.totalItems).toBe(1);
    expect(after.json.batches.map((b) => b.id)).toEqual([committed.json.batch.id]);
    const foreignUndo = await h.api("POST", `/api/workspaces/${other}/memory-review/undo`, {
      batchId: committed.json.batch.id,
    });
    expect(foreignUndo.status).toBe(404);
    const undone = await h.api<{ batch: MemoryReviewBatch }>(
      "POST",
      `/api/workspaces/${workspace.id}/memory-review/undo`,
      { batchId: committed.json.batch.id },
    );
    expect(undone.json.batch.undoneAt).toBeDefined();
    const bad = await h.api("POST", `/api/workspaces/${workspace.id}/memory-review/preview`, {
      groupKey: french.groupKey,
      decision: "approve-all",
    });
    expect(bad.status).toBe(400);
  });
});

describe("versions (surface 21)", () => {
  it("pages versions newest first with Load older and refuses a foreign cursor", async () => {
    h = await startHarness();
    const { workspace } = await h.seed();
    const ctx = h.app.deskmates.ctx;
    const entry = note(ctx, workspace.id, "Version zero.");
    for (let n = 1; n <= 29; n += 1)
      ctx.memory.entries.appendVersion(entry.id, "edit", { body: `Version ${n}.` }, "human:o");
    const path = `/api/memory/entries/${entry.id}/versions`;
    const all = await pages<{ version: number }>(h, path, "versions");
    expect(all.pages).toBe(2);
    expect(all.items.map((v) => v.version)).toEqual(Array.from({ length: 30 }, (_, i) => 30 - i));
    const other = note(ctx, workspace.id, "Another entry.");
    const first = await h.api<{ nextCursor: string }>("GET", path);
    expect(
      (
        await h.api(
          "GET",
          `/api/memory/entries/${other.id}/versions?cursor=${first.json.nextCursor}`,
        )
      ).status,
    ).toBe(400);
    expect((await h.api("GET", `${path}?limit=0`)).status).toBe(400);
  });
});
