// T1 (ADR-0011 Verification row 11): closing a thread's task produces one episode derived from its
// task state; that task state is in no later run's index, and the episode is searchable.

import { afterEach, beforeEach, expect, it } from "vitest";
import { type MemoryFixture, item, memoryFixture } from "../test-support/memory-fixture.js";
import { closeThreadTask } from "./episodes.js";
import { searchMemory } from "./search.js";

let f: MemoryFixture;
beforeEach(async () => {
  f = await memoryFixture();
});
afterEach(async () => {
  await f.close();
});

it("distils task state into one episode and removes it from later indexes", () => {
  f.learn(f.run(), [
    item("Refund sheet: rows 1-40 checked.", { proposedScope: "task" }),
    item("Refund sheet: submission path is Reports > Refunds.", {
      proposedScope: "task",
      trust: "untrusted",
    }),
  ]);
  const before = f.ctx.memory.indexFor(f.a.workspace.id, f.a.bot.id, f.a.thread.id);
  expect(before.sections.task).toHaveLength(1); // the untrusted one is never pinned

  const closed = closeThreadTask(f.ctx.memory.entries, f.a.thread, "human:owner");
  expect(closed.distilled).toHaveLength(2);
  expect(closed.episode).toMatchObject({
    scope: "task",
    kind: "episode",
    threadId: f.a.thread.id,
    trust: "untrusted",
  });
  expect(closed.episode?.derivedFrom).toEqual(closed.distilled);
  expect(closed.episode?.body).toContain("rows 1-40 checked");

  const after = f.ctx.memory.indexFor(f.a.workspace.id, f.a.bot.id, f.a.thread.id);
  expect(after.sections.task).toEqual([]);
  const hits = searchMemory(f.ctx.db, { workspaceId: f.a.workspace.id, query: "Refund sheet" });
  expect(hits.map((h) => h.kind)).toEqual(["episode"]);

  // Closing again with nothing open makes no second episode.
  expect(closeThreadTask(f.ctx.memory.entries, f.a.thread, "human:owner").episode).toBeUndefined();
});
