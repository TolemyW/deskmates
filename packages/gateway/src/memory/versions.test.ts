// T1 (ADR-0011 Verification row 7): edit, forget and undo each produce a new version; forget
// redacts the body of every prior version; undo restores the previous body verbatim. Version rows
// are immutable in the database itself.

import { afterEach, beforeEach, expect, it } from "vitest";
import { type MemoryFixture, item, memoryFixture } from "../test-support/memory-fixture.js";
import { confirmEntry, editEntry, forgetEntry, undoEntry } from "./versions.js";

let f: MemoryFixture;
beforeEach(async () => {
  f = await memoryFixture();
});
afterEach(async () => {
  await f.close();
});

function first() {
  f.learn(f.run(), [item("Exports are CSV with a BOM.", { trust: "untrusted" })]);
  const entry = f.ctx.memory.entries.list({ workspaceId: f.a.workspace.id })[0];
  if (!entry) throw new Error("no entry");
  return entry;
}

it("edits and undoes as new versions, restoring the previous body verbatim", () => {
  const entry = first();
  const edited = editEntry(
    f.ctx.memory.entries,
    f.a.workspace.id,
    entry.id,
    "Exports are CSV.",
    "human:o",
  );
  expect(edited.version).toBe(2);
  const undone = undoEntry(f.ctx.memory.entries, f.a.workspace.id, entry.id, "human:o");
  expect(undone.version).toBe(3);
  expect(undone.body).toBe("Exports are CSV with a BOM.");
  expect(f.ctx.memory.entries.versions(entry.id).map((v) => [v.version, v.op, v.body])).toEqual([
    [1, "create", "Exports are CSV with a BOM."],
    [2, "edit", "Exports are CSV."],
    [3, "undo", "Exports are CSV with a BOM."],
  ]);
});

it("confirms an untrusted entry as trusted with the human as source", () => {
  const entry = first();
  const confirmed = confirmEntry(f.ctx.memory.entries, f.a.workspace.id, entry.id, "human:o");
  expect(confirmed).toMatchObject({ trust: "trusted", sourceKind: "human", version: 2 });
  expect(confirmed.lastConfirmedAt).toBeDefined();
});

it("forgets with a tombstone and redacts every prior version", () => {
  const entry = first();
  editEntry(f.ctx.memory.entries, f.a.workspace.id, entry.id, "Exports are CSV.", "human:o");
  const gone = forgetEntry(f.ctx.memory.entries, f.a.workspace.id, entry.id, "human:o");
  expect(gone).toMatchObject({ tombstoned: true, body: "", version: 3 });
  const versions = f.ctx.memory.entries.versions(entry.id);
  expect(versions.map((v) => v.op)).toEqual(["create", "edit", "forget"]);
  expect(versions.every((v) => v.body === "" && v.redacted)).toBe(true);
  const dump = JSON.stringify(f.ctx.db.prepare("SELECT * FROM memory_versions").all());
  expect(dump).not.toContain("BOM");
  expect(() => undoEntry(f.ctx.memory.entries, f.a.workspace.id, entry.id, "human:o")).toThrow(
    "forgotten",
  );
});

it("refuses to rewrite a version row or delete one", () => {
  const entry = first();
  expect(() =>
    f.ctx.db
      .prepare("UPDATE memory_versions SET body = 'tampered' WHERE entry_id = ?")
      .run(entry.id),
  ).toThrow("immutable");
  expect(() =>
    f.ctx.db.prepare("DELETE FROM memory_versions WHERE entry_id = ?").run(entry.id),
  ).toThrow("immutable");
});

it("does not act on an entry through another workspace", () => {
  const entry = first();
  expect(() => editEntry(f.ctx.memory.entries, f.b.workspace.id, entry.id, "x", "human:o")).toThrow(
    "not found",
  );
});
