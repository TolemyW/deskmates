// T1 (ADR-0011 Verification row 10, G-XWS, zero tolerance): a canary written to workspace A's
// memory is absent from workspace B's pinned index, search results and consolidation input.

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

const CANARY = "CANARYXWS7f3a workspace A secret routing fact";

it("keeps workspace A's canary out of B's index, search and consolidation input", () => {
  f.learn(f.run("a"), [
    item(CANARY),
    item(`${CANARY} as task state`, { proposedScope: "task" }),
    item(`${CANARY} as experience`, { proposedScope: "bot" }),
  ]);
  closeThreadTask(f.ctx.memory.entries, f.a.thread, "human:owner");
  f.learn(f.run("b"), [
    item("Workspace B keeps its own facts."),
    item("Check B's queue first each morning.", { proposedScope: "bot" }),
  ]);

  // A sees its canary; B never does.
  expect(
    JSON.stringify(f.ctx.memory.indexFor(f.a.workspace.id, f.a.bot.id, f.a.thread.id)),
  ).toContain("CANARYXWS7f3a");
  const indexB = f.ctx.memory.indexFor(f.b.workspace.id, f.b.bot.id, f.b.thread.id);
  expect(JSON.stringify(indexB)).not.toContain("CANARYXWS7f3a");
  expect(searchMemory(f.ctx.db, { workspaceId: f.b.workspace.id, query: "CANARYXWS7f3a" })).toEqual(
    [],
  );
  expect(
    JSON.stringify(f.ctx.memory.entries.consolidationInput(f.b.workspace.id, f.b.bot.id)),
  ).not.toContain("CANARYXWS7f3a");
  expect(
    JSON.stringify(f.ctx.memory.entries.consolidationInput(f.a.workspace.id, f.a.bot.id)),
  ).toContain("CANARYXWS7f3a");

  // A consolidation run queued for B's bot carries no trace of A in its prompt or config.
  const run = f.ctx.memory.consolidation.request(f.b.bot.id);
  expect(JSON.stringify(run)).not.toContain("CANARYXWS7f3a");
});
