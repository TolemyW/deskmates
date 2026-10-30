// T1 (ADR-0011 Verification row 5, search half): memory_search returns trusted and untrusted
// entries of the run's workspace, each marked, never forgotten or closed ones; the internal route
// takes the workspace from the run token, not from the caller.

import { afterEach, expect, it } from "vitest";
import { type Harness, startHarness } from "../test-support/harness.js";
import { type MemoryFixture, item, memoryFixture } from "../test-support/memory-fixture.js";
import { searchMemory } from "./search.js";
import { forgetEntry } from "./versions.js";

let f: MemoryFixture | undefined;
let h: Harness | undefined;
afterEach(async () => {
  await f?.close();
  await h?.close();
  f = undefined;
  h = undefined;
});

it("returns trusted and untrusted entries marked, and nothing forgotten", async () => {
  f = await memoryFixture();
  f.learn(f.run(), [
    item("Invoice export uses semicolons."),
    item("Invoice page says totals exclude VAT.", { trust: "untrusted", sourceKind: "page" }),
    item("Invoice drafts expire after 7 days."),
  ]);
  const drafts = f.ctx.memory.entries
    .list({ workspaceId: f.a.workspace.id })
    .find((e) => e.body.includes("drafts"));
  forgetEntry(f.ctx.memory.entries, f.a.workspace.id, drafts?.id ?? "", "human:o");
  const hits = searchMemory(f.ctx.db, { workspaceId: f.a.workspace.id, query: "invoice" });
  expect(hits.map((hit) => [hit.body, hit.trust]).sort()).toEqual([
    ["Invoice export uses semicolons.", "trusted"],
    ["Invoice page says totals exclude VAT.", "untrusted"],
  ]);
  expect(hits.every((hit) => hit.learnedBy === f?.a.bot.name)).toBe(true);
  expect(
    searchMemory(f.ctx.db, { workspaceId: f.a.workspace.id, query: "invoice", scope: "task" }),
  ).toEqual([]);
});

it("pages operator search with a cursor so match 21 is not dropped (A15)", async () => {
  h = await startHarness();
  const { workspace } = await h.seed();
  const ctx = h.app.deskmates.ctx;
  for (let n = 1; n <= 23; n += 1)
    ctx.memory.entries.insert({
      workspaceId: workspace.id,
      scope: "workspace",
      kind: "note",
      body: `pagemarker item ${n} of the list`,
      authority: "fact",
      trust: "trusted",
      sourceKind: "human",
      by: "human:o",
    });
  const first = await h.api<{ entries: { id: string }[]; nextCursor?: string }>(
    "GET",
    `/api/workspaces/${workspace.id}/memory/search?q=pagemarker`,
  );
  expect(first.json.entries).toHaveLength(20);
  expect(first.json.nextCursor).toBeDefined();
  const second = await h.api<{ entries: { id: string }[]; nextCursor?: string }>(
    "GET",
    `/api/workspaces/${workspace.id}/memory/search?q=pagemarker&cursor=${first.json.nextCursor}`,
  );
  expect(second.json.entries).toHaveLength(3);
  expect(second.json.nextCursor).toBeUndefined();
  const ids = new Set([...first.json.entries, ...second.json.entries].map((e) => e.id));
  expect(ids.size).toBe(23);
  const bad = await h.api("GET", `/api/workspaces/${workspace.id}/memory/search?q=x&cursor=zz`);
  expect(bad.status).toBe(400);
});

it("finds a CJK word inside a longer run of characters", async () => {
  f = await memoryFixture();
  f.learn(f.run(), [item("发票导出使用分号")]);
  expect(searchMemory(f.ctx.db, { workspaceId: f.a.workspace.id, query: "分号" })).toHaveLength(1);
});

it("matches underscores literally in the substring fallback, never every note (#61 L8)", async () => {
  f = await memoryFixture();
  f.learn(f.run(), [item("Invoice export uses semicolons."), item("The key is a__b in config.")]);
  const ws = f.a.workspace.id;
  expect(searchMemory(f.ctx.db, { workspaceId: ws, query: "___" })).toEqual([]);
  expect(searchMemory(f.ctx.db, { workspaceId: ws, query: "__" }).map((hit) => hit.body)).toEqual([
    "The key is a__b in config.",
  ]);
});

it("scopes the internal route to the run's own workspace", async () => {
  h = await startHarness();
  const { bot, workspace } = await h.seed();
  const other = await h.api<{ workspace: { id: string } }>("POST", "/api/workspaces", {
    defaultBot: false,
    name: "other",
    egressAllowlist: [],
  });
  const ctx = h.app.deskmates.ctx;
  ctx.memory.entries.insert({
    workspaceId: workspace.id,
    scope: "workspace",
    kind: "note",
    body: "searchmarker in own workspace",
    authority: "fact",
    trust: "trusted",
    sourceKind: "human",
    by: "human:o",
  });
  ctx.memory.entries.insert({
    workspaceId: other.json.workspace.id as typeof workspace.id,
    scope: "workspace",
    kind: "note",
    body: "searchmarker in the other workspace",
    authority: "fact",
    trust: "trusted",
    sourceKind: "human",
    by: "human:o",
  });
  const run = ctx.runs.create({
    botId: bot.id,
    lane: "background",
    triggerKind: "cron",
    triggerRef: "search-scope",
    config: ctx.runConfig(),
  });
  const { token } = ctx.tokens.issue(run.id);
  const res = await fetch(`${h.baseUrl}/internal/runs/${run.id}/memory/search?q=searchmarker`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { entries: { id: string; body: string; version: number }[] };
  expect(body.entries.map((e) => e.body)).toEqual(["searchmarker in own workspace"]);
  // ADR-0011 A13: what the run received is recorded with its exact version.
  expect(ctx.memory.supplied.list(workspace.id, run.id)).toEqual([
    expect.objectContaining({
      entryId: body.entries[0]?.id,
      version: body.entries[0]?.version,
      via: "search",
    }),
  ]);
  const denied = await fetch(`${h.baseUrl}/internal/runs/${run.id}/memory/search?q=searchmarker`);
  expect(denied.status).toBe(401);
});
