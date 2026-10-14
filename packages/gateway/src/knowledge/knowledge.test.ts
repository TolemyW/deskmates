import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type GatewayDb, openDatabase } from "../db/open.js";
import { KnowledgeStore } from "./knowledge.js";

const T = "tnt_default";

describe("reviewed team knowledge", () => {
  let db: GatewayDb;
  let dir: string;
  let store: KnowledgeStore;
  beforeEach(() => {
    db = openDatabase(":memory:");
    dir = mkdtempSync(join(tmpdir(), "deskmates-knowledge-"));
    store = new KnowledgeStore(db, dir);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it("publishes only after review and preserves Markdown across store restart", () => {
    const proposal = store.propose(
      T,
      "Refund procedure",
      "Check the refund invoice before approval.",
    );
    expect(store.search(T, "refund")).toEqual([]);
    expect(() => store.read(T, proposal.id)).toThrow("not found");
    const reviewed = store.review(T, proposal.id, "approve", "human:web");
    const id = reviewed.documentId as string;
    expect(store.search(T, "refund")).toMatchObject([
      { id, title: "Refund procedure", version: 1 },
    ]);
    expect(new KnowledgeStore(db, dir).read(T, id).body).toBe(proposal.body);
    expect(readdirSync(dir)).toHaveLength(1);
    expect(() => store.review(T, proposal.id, "reject", "human:other")).toThrow(
      "already been reviewed",
    );
  });
  it("keeps rejection private and handles FTS operators as text", () => {
    const proposal = store.propose(T, "Private draft", "unpublishedtoken");
    store.review(T, proposal.id, "reject", "human:web");
    expect(store.search(T, 'unpublishedtoken OR "')).toEqual([]);
    expect(store.documentRows(T, 25).rows).toEqual([]);
    expect(store.documentCount(T)).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
  });
  it("updates the index atomically and refuses a stale operator edit", () => {
    const id = store.review(T, store.propose(T, "Old", "oldword").id, "approve", "human:web")
      .documentId as string;
    expect(store.edit(T, id, "New", "newword", 1, "human:web").version).toBe(2);
    expect(store.search(T, "oldword")).toEqual([]);
    expect(store.search(T, "newword")).toHaveLength(1);
    expect(() => store.edit(T, id, "Stale", "discard", 1, "human:web")).toThrow("reload");
    expect(store.read(T, id).body).toBe("newword");
    expect(store.history(T, id).items.map((item) => item.version)).toEqual([2, 1]);
  });
  it("paginates published documents and removes only unreferenced version files", () => {
    const first = store.review(T, store.propose(T, "First", "one").id, "approve", "human:web")
      .documentId as string;
    store.review(T, store.propose(T, "Second", "two").id, "approve", "human:web");
    store.edit(T, first, "First updated", "three", 1, "human:web");
    const page = store.documentRows(T, 1).rows;
    expect(page).toHaveLength(2);
    expect(store.documentRows(T, 1, page[0]?.key).rows).toHaveLength(1);
    expect(store.documentCount(T)).toBe(2);
    const referenced = new Set(readdirSync(dir));
    const orphan = "kb_deadbeef.9.11111111-1111-1111-1111-111111111111.md";
    writeFileSync(join(dir, orphan), "orphan");
    expect(store.cleanupOrphanVersions()).toEqual({
      removed: 1,
      retained: referenced.size,
    });
    expect(new Set(readdirSync(dir))).toEqual(referenced);
    expect(store.history(T, first).items.map((item) => item.body)).toEqual(["three", "one"]);
  });
  it("does not publish when Markdown storage fails", () => {
    const proposal = store.propose(T, "Failure", "neverpublished");
    const blocked = join(dir, "file");
    writeFileSync(blocked, "not a directory");
    expect(() =>
      new KnowledgeStore(db, blocked).review(T, proposal.id, "approve", "human:web"),
    ).toThrow();
    expect(store.proposal(T, proposal.id).status).toBe("pending");
    expect(store.search(T, "neverpublished")).toEqual([]);
  });
  it("refuses modified Markdown or a database path escaping its managed directory", () => {
    const id = store.review(T, store.propose(T, "Stable", "original").id, "approve", "human:web")
      .documentId as string;
    writeFileSync(join(dir, readdirSync(dir)[0] as string), "modified");
    expect(() => store.read(T, id)).toThrow("disagree");
    db.prepare("UPDATE knowledge_docs SET path='../secret' WHERE id=?").run(id);
    expect(() => store.read(T, id)).toThrow("storage path");
  });
});
