// T1 (ADR-0011 Verification row 6): a contradicting workspace fact closes the old interval and
// points at its successor; the old row stays readable; TTL expiry takes an entry out of the index.

import { afterEach, beforeEach, expect, it } from "vitest";
import { type MemoryFixture, item, memoryFixture } from "../test-support/memory-fixture.js";
import { isLive } from "./validity.js";

let f: MemoryFixture;
beforeEach(async () => {
  f = await memoryFixture();
});
afterEach(async () => {
  await f.close();
});

it("closes an untrusted fact's interval when a contradicting fact arrives", () => {
  f.learn(f.run(), [item("The quota page lists 40 seats.", { trust: "untrusted" })]);
  const [old] = f.ctx.memory.entries.list({ workspaceId: f.a.workspace.id });
  const outcomes = f.learn(f.run(), [
    item("The quota page lists 50 seats.", { trust: "untrusted" }),
  ]);
  expect(outcomes[0]).toMatchObject({ outcome: "applied", superseded: [old?.id] });
  const closed = f.ctx.memory.entries.mustGet(old?.id ?? "");
  const next = f.ctx.memory.entries
    .list({ workspaceId: f.a.workspace.id })
    .find((e) => e.id !== old?.id);
  expect(closed.invalidAt).toBeDefined();
  expect(closed.supersededBy).toBe(next?.id);
  // Still readable, interval and body intact.
  expect(closed.body).toBe("The quota page lists 40 seats.");
  expect(closed.validFrom <= (closed.invalidAt ?? "")).toBe(true);
  expect(isLive(closed, new Date())).toBe(false);
});

it("drops an entry from the index once its TTL has run out", () => {
  const entry = f.ctx.memory.entries.insert({
    workspaceId: f.a.workspace.id,
    scope: "workspace",
    kind: "note",
    body: "The maintenance banner is up.",
    authority: "fact",
    trust: "trusted",
    sourceKind: "human",
    observedAt: "2026-09-29T00:00:00.000Z",
    ttlSeconds: 3600,
    by: "human:owner",
  });
  const inside = f.ctx.memory.indexFor(
    f.a.workspace.id,
    f.a.bot.id,
    undefined,
    new Date("2026-09-29T00:30:00.000Z"),
  );
  const after = f.ctx.memory.indexFor(
    f.a.workspace.id,
    f.a.bot.id,
    undefined,
    new Date("2026-09-29T01:00:01.000Z"),
  );
  expect(inside.versionSet.map((v) => v.entryId)).toEqual([entry.id]);
  expect(after.versionSet).toEqual([]);
});
