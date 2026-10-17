// T1 (ADR-0011 amendment 4, A26 to A28): the revalidation sweep flags qualifying notes once,
// closes flags whose note moved on, never touches a note or creates a run; a human answers a
// flag with "still true" or "dismiss", audited, and the pinned index does not change.

import type { WorkspaceId } from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MemoryFixture, item, memoryFixture } from "../test-support/memory-fixture.js";
import type { NewEntry } from "./entries.js";
import { forgetEntry } from "./versions.js";

let f: MemoryFixture;
beforeEach(async () => {
  f = await memoryFixture();
});
afterEach(async () => {
  await f.close();
});

const NOW = new Date("2026-10-14T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

function note(body: string, over: Partial<NewEntry> = {}) {
  return f.ctx.memory.entries.insert({
    workspaceId: f.a.workspace.id,
    scope: "workspace",
    kind: "note",
    body,
    authority: "fact",
    trust: "trusted",
    sourceKind: "bot_self",
    observedAt: daysAgo(120),
    effectiveAt: daysAgo(120),
    by: "test",
    ...over,
  });
}

const count = (sql: string, ...params: unknown[]) =>
  (f.ctx.db.prepare(sql).get(...params) as { n: number }).n;

function openFlags(workspaceId: WorkspaceId = f.a.workspace.id) {
  return f.ctx.memory.freshness.page(workspaceId, { limit: 100 });
}

describe("A26 sweep", () => {
  it("flags exactly the qualifying notes, once, and creates no run", () => {
    const old = note("The billing export runs on Mondays.");
    note("The staging host is staging.example.test.", { effectiveAt: daysAgo(0.5) });
    note("Thread state: 3 of 5 rows imported.", {
      scope: "task",
      threadId: f.a.thread.id,
    });
    const expiring = note("The release freeze lasts until Friday.", {
      observedAt: daysAgo(10),
      effectiveAt: daysAgo(10),
      ttlSeconds: 12 * 86_400,
    });
    const runs = count("SELECT COUNT(*) AS n FROM runs");
    const versions = count("SELECT COUNT(*) AS n FROM memory_versions");

    expect(f.ctx.memory.freshness.sweep(f.a.workspace.id, NOW)).toEqual({
      flagged: 2,
      updated: 0,
      closed: 0,
    });
    // A second sweep, or one after a restart, adds nothing.
    expect(f.ctx.memory.freshness.sweep(f.a.workspace.id, NOW)).toEqual({
      flagged: 0,
      updated: 0,
      closed: 0,
    });
    const page = openFlags();
    expect(page.items.map((r) => [r.entryId, r.reason]).sort()).toEqual(
      [
        [old.id, "age"],
        [expiring.id, "ttl_expiring"],
      ].sort(),
    );
    expect(page.total).toBe(2);
    expect(page.byReason).toEqual({ age: 1, ttl_expiring: 1 });
    expect(page.items.find((r) => r.reason === "age")?.horizonDays).toBe(1);
    // A28: the sweep writes flag rows only.
    expect(count("SELECT COUNT(*) AS n FROM runs")).toBe(runs);
    expect(count("SELECT COUNT(*) AS n FROM memory_versions")).toBe(versions);
    // Another workspace is untouched.
    expect(openFlags(f.b.workspace.id).total).toBe(0);
  });

  it("moves an open flag to the more urgent reason and closes flags whose note moved on", () => {
    const expiring = note("The release freeze lasts until Friday.", {
      observedAt: daysAgo(10),
      effectiveAt: daysAgo(10),
      ttlSeconds: 12 * 86_400,
    });
    const forgotten = note("The billing export runs on Mondays.");
    const edited = note("The audit report is due quarterly.");
    f.ctx.memory.freshness.sweep(f.a.workspace.id, NOW);
    expect(openFlags().total).toBe(3);

    const later = new Date(NOW.getTime() + 3 * 86_400_000);
    forgetEntry(f.ctx.memory.entries, f.a.workspace.id, forgotten.id, "human:owner");
    f.ctx.memory.entries.appendVersion(
      edited.id,
      "edit",
      { body: "The audit report is due quarterly.", lastConfirmedAt: later.toISOString() },
      "human:owner",
    );
    expect(f.ctx.memory.freshness.sweep(f.a.workspace.id, later)).toEqual({
      flagged: 0,
      updated: 1,
      closed: 2,
    });
    expect(openFlags().items.map((r) => [r.entryId, r.reason])).toEqual([
      [expiring.id, "ttl_expired"],
    ]);
    const outcome = (entryId: string) =>
      (
        f.ctx.db
          .prepare("SELECT status FROM memory_revalidations WHERE entry_id = ?")
          .get(entryId) as { status: string }
      ).status;
    expect(outcome(forgotten.id)).toBe("forgotten");
    expect(outcome(edited.id)).toBe("resolved");
  });

  it("flags an untrusted value that replaced a trusted fact, and closes the flag on supersession", () => {
    f.learn(f.run(), [item("The quota page lists 40 seats.")]);
    f.learn(f.run(), [item("The quota page lists 50 seats.", { trust: "untrusted" })]);
    f.ctx.memory.freshness.sweep(f.a.workspace.id);
    const [flag] = openFlags().items;
    expect(flag).toMatchObject({ reason: "replaced_trusted", entry: { trust: "untrusted" } });

    f.learn(f.run(), [item("The quota page lists 60 seats.")]);
    f.ctx.memory.freshness.sweep(f.a.workspace.id);
    expect(openFlags().total).toBe(0);
    expect(f.ctx.memory.freshness.get(f.a.workspace.id, flag?.id ?? "").status).toBe("superseded");
  });

  it("sweeps a workspace at most once an hour from the periodic pass", () => {
    note("The billing export runs on Mondays.");
    expect(f.ctx.memory.freshness.sweepDue(NOW)).toBe(1);
    expect(f.ctx.memory.freshness.sweepDue(new Date(NOW.getTime() + 30 * 60_000))).toBe(0);
    expect(f.ctx.memory.freshness.sweepDue(new Date(NOW.getTime() + 61 * 60_000))).toBe(1);
  });

  it("pages open flags without duplicates and with a stable order", () => {
    for (let i = 0; i < 5; i += 1) note(`Old fact number ${i} about the ledger host h${i}.`);
    f.ctx.memory.freshness.sweep(f.a.workspace.id, NOW);
    const first = f.ctx.memory.freshness.page(f.a.workspace.id, { limit: 2 });
    const last = first.items.at(-1);
    const second = f.ctx.memory.freshness.page(f.a.workspace.id, {
      limit: 10,
      ...(last ? { after: [last.flaggedAt, last.id] as const } : {}),
    });
    expect(first.more).toBe(true);
    expect(second.more).toBe(false);
    const ids = [...first.items, ...second.items].map((r) => r.id);
    expect(new Set(ids).size).toBe(5);
    expect(first.total).toBe(5);
  });
});

describe("A27 decisions", () => {
  it("still true renews the note with a confirm version, trust unchanged, and audits it", () => {
    const expired = note("The release freeze lasts until Friday.", {
      trust: "untrusted",
      observedAt: daysAgo(10),
      effectiveAt: daysAgo(10),
      ttlSeconds: 5 * 86_400,
    });
    f.ctx.memory.freshness.sweep(f.a.workspace.id, NOW);
    const [flag] = openFlags().items;
    expect(flag?.reason).toBe("ttl_expired");

    const decided = f.ctx.memory.freshness.decide(
      f.ctx.audit,
      { workspaceId: f.a.workspace.id, id: flag?.id ?? "", decision: "still_true", by: "user:u1" },
      NOW,
    );
    expect(decided.status).toBe("still_true");
    const entry = f.ctx.memory.entries.mustGet(expired.id);
    expect(entry.trust).toBe("untrusted");
    expect(entry.lastConfirmedAt).toBe(NOW.toISOString());
    expect(f.ctx.memory.entries.version(expired.id, entry.version)?.op).toBe("confirm");
    expect(count("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'memory.revalidate'")).toBe(
      1,
    );
    // Renewed: the next sweep has nothing to flag.
    expect(f.ctx.memory.freshness.sweep(f.a.workspace.id, NOW).flagged).toBe(0);
    // An answered flag is not answered twice.
    expect(() =>
      f.ctx.memory.freshness.decide(f.ctx.audit, {
        workspaceId: f.a.workspace.id,
        id: flag?.id ?? "",
        decision: "dismiss",
        by: "user:u1",
      }),
    ).toThrow(/already answered/);
  });

  it("dismiss changes no note and the same version is not flagged again for that reason", () => {
    const old = note("The billing export runs on Mondays.");
    f.ctx.memory.freshness.sweep(f.a.workspace.id, NOW);
    const [flag] = openFlags().items;
    const before = f.ctx.memory.entries.mustGet(old.id);
    f.ctx.memory.freshness.decide(
      f.ctx.audit,
      { workspaceId: f.a.workspace.id, id: flag?.id ?? "", decision: "dismiss", by: "user:u1" },
      NOW,
    );
    expect(f.ctx.memory.entries.mustGet(old.id)).toEqual(before);
    expect(f.ctx.memory.freshness.sweep(f.a.workspace.id, NOW).flagged).toBe(0);
  });

  it("leaves the pinned index unchanged and refuses another workspace's flag", () => {
    note("The billing export runs on Mondays.");
    const before = f.ctx.memory.indexFor(f.a.workspace.id, f.a.bot.id, undefined, NOW);
    f.ctx.memory.freshness.sweep(f.a.workspace.id, NOW);
    const after = f.ctx.memory.indexFor(f.a.workspace.id, f.a.bot.id, undefined, NOW);
    expect(after.versionSet).toEqual(before.versionSet);
    const [flag] = openFlags().items;
    expect(() => f.ctx.memory.freshness.get(f.b.workspace.id, flag?.id ?? "")).toThrow(/not found/);
    expect(() =>
      f.ctx.memory.freshness.decide(f.ctx.audit, {
        workspaceId: f.a.workspace.id,
        id: flag?.id ?? "",
        decision: "approve",
        by: "user:u1",
      }),
    ).toThrow(/still_true or dismiss/);
  });
});
