// T1 (ADR-0011 amendment 2, Verification A7 to A13): a newer value of the same fact silently
// becomes current; older values stay as history with sources and receipts; different facts,
// stores and workspaces coexist; ordering follows validated times, never arrival alone;
// duplicates add sources without corroborating; trust never rises; undo restores; the memory a
// run received is recorded and never rewritten.

import type { RunId, WorkspaceId } from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MemoryFixture, item, memoryFixture } from "../test-support/memory-fixture.js";
import type { StoredEntry } from "./entries.js";
import { writeFact } from "./recency.js";
import { searchMemory } from "./search.js";
import { forgetEntry, undoEntry } from "./versions.js";

let f: MemoryFixture;
beforeEach(async () => {
  f = await memoryFixture();
});
afterEach(async () => {
  await f.close();
});

const ws = () => f.a.workspace.id;
const all = (workspaceId: WorkspaceId = ws()) => f.ctx.memory.entries.list({ workspaceId });
const current = (workspaceId: WorkspaceId = ws()) =>
  all(workspaceId).filter((e) => e.kind === "note" && e.invalidAt === undefined);
const bodyOf = (id: string) => f.ctx.memory.entries.mustGet(id).body;
const entryId = (outcome: unknown) => (outcome as { entryId: string }).entryId;
const runCreated = (run: RunId) => f.ctx.runs.mustGet(run).createdAt;
const later = (run: RunId, seconds: number) =>
  new Date(Date.parse(runCreated(run)) + seconds * 1000).toISOString();

describe("silent supersession (A6, A8, A12)", () => {
  it("makes the newer value current with no confirmation and keeps the older as history", () => {
    const [first] = f.learn(f.run(), [item("The quota page lists 40 seats.")]);
    const [second] = f.learn(f.run(), [item("The quota page lists 50 seats.")]);
    expect(second).toMatchObject({ outcome: "applied", superseded: [entryId(first)] });
    expect(f.ctx.memory.confirmations.list({ status: "pending" }).suggestions).toEqual([]);

    expect(current().map((e) => e.body)).toEqual(["The quota page lists 50 seats."]);
    const hits = searchMemory(f.ctx.db, { workspaceId: ws(), query: "quota seats" });
    expect(hits.map((h) => h.body)).toEqual(["The quota page lists 50 seats."]);
    const index = f.ctx.memory.indexFor(ws(), f.a.bot.id);
    expect(index.sections.workspace.map((l) => l.body)).toEqual(["The quota page lists 50 seats."]);

    const old = f.ctx.memory.entries.mustGet(entryId(first));
    expect(old).toMatchObject({
      supersededBy: entryId(second),
      body: "The quota page lists 40 seats.",
    });
    expect(f.ctx.memory.entries.versions(old.id).map((v) => v.op)).toEqual(["create", "supersede"]);
    const [receipt] = f.ctx.memory.entries.supersessions(ws(), old.id);
    expect(receipt).toMatchObject({
      entryId: old.id,
      winnerId: entryId(second),
      reason: "newer_effective_time",
      factKey: old.factKey,
    });
  });

  it("restores the older value through undo and closes the newer with undo_restore", () => {
    const [first] = f.learn(f.run(), [item("The quota page lists 40 seats.")]);
    const [second] = f.learn(f.run(), [item("The quota page lists 50 seats.")]);
    const restored = undoEntry(f.ctx.memory.entries, ws(), entryId(first), "human:o");
    expect(restored.invalidAt).toBeUndefined();
    expect(restored.supersededBy).toBeUndefined();
    expect(f.ctx.memory.entries.mustGet(entryId(second))).toMatchObject({
      supersededBy: entryId(first),
    });
    expect(
      f.ctx.memory.entries.supersessions(ws(), entryId(second)).map((r) => r.reason),
    ).toContain("undo_restore");
    expect(current().map((e) => e.body)).toEqual(["The quota page lists 40 seats."]);
  });

  it("does not bring back an older value when the current one is forgotten", () => {
    f.learn(f.run(), [item("The quota page lists 40 seats.")]);
    const [second] = f.learn(f.run(), [item("The quota page lists 50 seats.")]);
    forgetEntry(f.ctx.memory.entries, ws(), entryId(second), "human:o");
    expect(current()).toEqual([]);
    // The forgotten body's words leave no trace in the receipts either.
    expect(
      f.ctx.memory.entries.supersessions(ws(), entryId(second)).every((r) => r.factKey === ""),
    ).toBe(true);
  });
});

describe("what counts as the same fact (A7)", () => {
  it("lets different subjects, conditions, stores and workspaces coexist", () => {
    f.learn(f.run(), [
      item("The quota page lists 40 seats."),
      item("The billing page lists 40 seats."),
      item("PostgreSQL 15 caps names at 63 bytes."),
      item("PostgreSQL 16 caps names at 64 bytes."),
      item("The quota page lists 45 seats.", { proposedScope: "task" }),
    ]);
    f.learn(f.run("b"), [item("The quota page lists 99 seats.")]);
    expect(
      current()
        .map((e) => e.body)
        .sort(),
    ).toEqual([
      "PostgreSQL 15 caps names at 63 bytes.",
      "PostgreSQL 16 caps names at 64 bytes.",
      "The billing page lists 40 seats.",
      "The quota page lists 40 seats.",
      "The quota page lists 45 seats.",
    ]);
    expect(current(f.b.workspace.id).map((e) => e.body)).toEqual([
      "The quota page lists 99 seats.",
    ]);
    expect(f.ctx.db.prepare("SELECT COUNT(*) AS n FROM memory_supersessions").get()).toEqual({
      n: 0,
    });
  });
});

describe("recency order (A9)", () => {
  it("keeps a late older observation as history instead of rolling the fact back", () => {
    const early = f.run();
    const late = f.run();
    f.learn(late, [item("The quota page lists 50 seats.")]);
    const [older] = f.learn(early, [item("The quota page lists 40 seats.")]);
    expect(older).toMatchObject({ outcome: "history", reason: "older_arrival" });
    expect(current().map((e) => e.body)).toEqual(["The quota page lists 50 seats."]);
    expect(f.ctx.memory.entries.mustGet(entryId(older)).effectiveBasis).toBe("run");
  });

  it("orders by the sidecar's turn stamp within the run, not by arrival", () => {
    const one = f.run();
    const two = f.run();
    // Run two started later, but run one observed its value after that.
    f.learn(one, [item("The quota page lists 40 seats.", { observedAt: later(one, 10) })]);
    const [second] = f.learn(two, [
      item("The quota page lists 50 seats.", { observedAt: later(two, 1) }),
    ]);
    expect(second).toMatchObject({ outcome: "history", reason: "older_arrival" });
    expect(f.ctx.memory.entries.mustGet(entryId(second)).effectiveBasis).toBe("source");
  });

  it("clamps a future stamp and never reads a date written in the text", () => {
    const one = f.run();
    const [stamped] = f.learn(one, [
      item("The quota page lists 40 seats.", { observedAt: "2099-01-01T00:00:00.000Z" }),
    ]);
    const entry = f.ctx.memory.entries.mustGet(entryId(stamped));
    expect(Date.parse(entry.effectiveAt)).toBeLessThanOrEqual(Date.now());
    // A model-written "as of" date in the body does not make an older run's value newer.
    const [claimed] = f.learn(f.run(), [item("As of 2099-12-31 the quota page lists 70 seats.")]);
    expect(claimed).toMatchObject({ outcome: "history", reason: "older_arrival" });
  });

  it("breaks an exact tie by ingestion time, then by entry id, with the reason recorded", () => {
    const store = f.ctx.memory.entries;
    const base = {
      workspaceId: ws(),
      scope: "workspace" as const,
      kind: "note" as const,
      authority: "fact" as const,
      trust: "trusted" as const,
      sourceKind: "bot_self" as const,
      effectiveAt: "2026-10-13T10:00:00.000Z",
      by: "test",
    };
    const t1 = new Date("2026-10-13T10:05:00.000Z");
    const t2 = new Date("2026-10-13T10:06:00.000Z");
    writeFact(store, { ...base, body: "The quota page lists 40 seats." }, t1);
    const second = writeFact(store, { ...base, body: "The quota page lists 50 seats." }, t2);
    expect(second.kind).toBe("current");
    const [receipt] = store.supersessions(
      ws(),
      (second as { superseded: string[] }).superseded[0] ?? "",
    );
    expect(receipt?.reason).toBe("tie_later_ingestion");
    // Same effective and ingestion time: the larger id wins, deterministically.
    const third = writeFact(store, { ...base, body: "The quota page lists 60 seats." }, t2);
    const secondId = (second as { entry: StoredEntry }).entry.id;
    if (third.entry.id > secondId) {
      expect(third.kind).toBe("current");
      const closed = third.kind === "current" ? (third.superseded[0] ?? "") : "";
      // Both receipts of `closed` share one timestamp, so pick the one that closed it.
      const receipts = store.supersessions(ws(), closed);
      expect(receipts.find((r) => r.entryId === closed)?.reason).toBe("tie_entry_id");
    } else expect(third).toMatchObject({ kind: "history", reason: "older_arrival" });
    expect(current()).toHaveLength(1);
  });
});

describe("one current value, written atomically (A8)", () => {
  it("leaves exactly one current note whatever the order of arrival", () => {
    const runs = [f.run(), f.run(), f.run(), f.run(), f.run()];
    for (const n of [3, 0, 4, 1, 2]) {
      f.learn(runs[n] as RunId, [item(`The quota page lists ${(n + 1) * 10} seats.`)]);
    }
    expect(current().map((e) => e.body)).toEqual(["The quota page lists 50 seats."]);
    expect(all()).toHaveLength(5);
  });

  it("refuses a second current note for one key at the database", () => {
    f.learn(f.run(), [item("The quota page lists 40 seats.")]);
    const [existing] = current();
    expect(() =>
      f.ctx.memory.entries.insert({
        workspaceId: ws(),
        scope: "workspace",
        kind: "note",
        body: "The quota page lists 41 seats.",
        authority: "fact",
        trust: "trusted",
        sourceKind: "human",
        ...(existing?.factKey ? { factKey: existing.factKey } : {}),
        by: "test",
      }),
    ).toThrow(/UNIQUE/);
  });

  it("returns the earlier outcome for a redelivered summary and changes nothing", () => {
    const run = f.run();
    f.learn(f.run(), [item("The quota page lists 40 seats.")]);
    const first = f.learn(run, [item("The quota page lists 50 seats.")]);
    const count = (table: string) =>
      (f.ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const before = [
      count("memory_entries"),
      count("memory_entry_sources"),
      count("memory_supersessions"),
    ];
    const again = f.learn(run, [item("The quota page lists 50 seats.")]);
    expect(again[0]).toEqual({ ordinal: 0, outcome: "replayed", entryId: entryId(first[0]) });
    expect([
      count("memory_entries"),
      count("memory_entry_sources"),
      count("memory_supersessions"),
    ]).toEqual(before);
  });

  it("gives notes written before amendment 2 a key, ordering duplicates of one fact", () => {
    const insertLegacy = (body: string, observedAt: string) => {
      const entry = f.ctx.memory.entries.insert({
        workspaceId: ws(),
        scope: "workspace",
        kind: "note",
        body,
        authority: "fact",
        trust: "trusted",
        sourceKind: "human",
        observedAt,
        by: "test",
      });
      f.ctx.db
        .prepare("UPDATE memory_entries SET fact_key = NULL, effective_at = NULL WHERE id = ?")
        .run(entry.id);
      return entry.id;
    };
    const older = insertLegacy("The quota page lists 40 seats.", "2026-09-01T00:00:00.000Z");
    const newer = insertLegacy("The quota page lists 50 seats.", "2026-09-02T00:00:00.000Z");
    f.ctx.memory.indexFor(ws(), f.a.bot.id);
    expect(current().map((e) => e.id)).toEqual([newer]);
    expect(f.ctx.memory.entries.supersessions(ws(), older)[0]?.reason).toBe("backfill");
  });
});

describe("duplicates and trust (A10, A11)", () => {
  it("adds a source for an equivalent copy without corroborating it", () => {
    const one = f.run();
    const middle = f.run();
    const two = f.run();
    const [first] = f.learn(one, [item("The quota page lists 40 seats.")]);
    const [copy] = f.learn(two, [item("the quota page lists 40 seats")]);
    expect(copy).toEqual({ ordinal: 0, outcome: "deduplicated", entryId: entryId(first) });
    const entry = f.ctx.memory.entries.mustGet(entryId(first));
    expect(entry).toMatchObject({ trust: "trusted", effectiveAt: runCreated(two) });
    expect(entry.lastConfirmedAt).toBeUndefined();
    expect(f.ctx.memory.entries.sources(ws(), entry.id).map((s) => s.sourceRunId)).toEqual([
      one,
      two,
    ]);
    // The later copy keeps the value current against an observation made in between.
    const [between] = f.learn(middle, [item("The quota page lists 50 seats.")]);
    expect(between).toMatchObject({ outcome: "history", reason: "older_arrival" });
  });

  it("never merges across trust levels", () => {
    f.learn(f.run(), [item("The quota page lists 40 seats.")]);
    const [lower] = f.learn(f.run(), [
      item("The quota page lists 40 seats.", { trust: "untrusted", sourceKind: "page" }),
    ]);
    expect(lower).toMatchObject({ outcome: "history", reason: "equivalent_lower_trust" });

    f.learn(f.run(), [item("The export page lists 9 columns.", { trust: "untrusted" })]);
    const [higher] = f.learn(f.run(), [item("The export page lists 9 columns.")]);
    expect(higher).toMatchObject({ outcome: "applied" });
    const replaced = (higher as { superseded: string[] }).superseded[0] ?? "";
    expect(f.ctx.memory.entries.supersessions(ws(), replaced)[0]?.reason).toBe(
      "equivalent_higher_trust",
    );
    expect(
      current()
        .map((e) => [e.body, e.trust])
        .sort(),
    ).toEqual([
      ["The export page lists 9 columns.", "trusted"],
      ["The quota page lists 40 seats.", "trusted"],
    ]);
  });

  it("lets an untrusted newer value replace a trusted one without trusting or pinning it", () => {
    const soul = f.ctx.bots.canonicalSoul(f.a.bot.id);
    const rules = f.ctx.rules.list(f.a.bot.id);
    const egress = f.ctx.workspaces.mustGet(ws()).egressAllowlist;
    f.learn(f.run(), [item("The quota page lists 40 seats.")]);
    const [page] = f.learn(f.run(), [
      item("The quota page lists 999 seats.", { trust: "untrusted", sourceKind: "page" }),
    ]);
    expect(page).toMatchObject({ outcome: "applied" });
    expect(bodyOf(entryId(page))).toBe("The quota page lists 999 seats.");
    expect(f.ctx.memory.entries.mustGet(entryId(page)).trust).toBe("untrusted");
    const index = f.ctx.memory.indexFor(ws(), f.a.bot.id);
    expect(index.versionSet).toEqual([]);
    expect(
      searchMemory(f.ctx.db, { workspaceId: ws(), query: "quota" }).map((h) => [h.body, h.trust]),
    ).toEqual([["The quota page lists 999 seats.", "untrusted"]]);
    expect(f.ctx.bots.canonicalSoul(f.a.bot.id)).toEqual(soul);
    expect(f.ctx.rules.list(f.a.bot.id)).toEqual(rules);
    expect(f.ctx.workspaces.mustGet(ws()).egressAllowlist).toEqual(egress);
  });

  it("filters a do-not-learn item before it can take part in ordering", () => {
    f.learn(f.run(), [item("The billing service is reachable from the workspace.")]);
    const [skipped] = f.learn(f.run(), [item("The billing service is down.")]);
    expect(skipped).toMatchObject({ outcome: "skipped", reason: "negative_capability_claim" });
    expect(current()).toHaveLength(1);
  });
});

describe("the memory a run received (A13)", () => {
  it("records pinned and searched versions and keeps them through a supersession", async () => {
    const [first] = f.learn(f.run(), [item("The quota page lists 40 seats.")]);
    const consumer = f.run();
    const index = f.ctx.memory.indexForRun(consumer, ws(), f.a.bot.id);
    const version = index.versionSet[0];
    expect(version?.entryId).toBe(entryId(first));
    f.learn(f.run(), [item("The quota page lists 50 seats.")]);
    const supplied = f.ctx.memory.supplied.list(ws(), consumer);
    expect(supplied).toEqual([
      expect.objectContaining({
        entryId: entryId(first),
        version: version?.version,
        via: "pinned",
      }),
    ]);
    // The recorded version's body is unchanged by the supersession.
    expect(f.ctx.memory.entries.version(entryId(first), version?.version ?? 0)?.body).toBe(
      "The quota page lists 40 seats.",
    );
  });
});
