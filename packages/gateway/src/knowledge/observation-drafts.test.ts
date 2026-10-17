// T1 (ADR-0011 amendment 4, A29): a Knowledge draft from learned-memory notes is a pending
// proposal with citations; only trusted current notes of the workspace can be cited; nothing is
// published until an Admin approves; a targeted update applies only at the version it read.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NewEntry } from "../memory/entries.js";
import { type MemoryFixture, item, memoryFixture } from "../test-support/memory-fixture.js";
import { draftFromObservations } from "./observation-drafts.js";

let f: MemoryFixture;
beforeEach(async () => {
  f = await memoryFixture();
});
afterEach(async () => {
  await f.close();
});

const TENANT = () =>
  (
    f.ctx.db.prepare("SELECT tenant_id FROM workspaces WHERE id = ?").get(f.a.workspace.id) as {
      tenant_id: string;
    }
  ).tenant_id;

function note(body: string, over: Partial<NewEntry> = {}) {
  return f.ctx.memory.entries.insert({
    workspaceId: f.a.workspace.id,
    scope: "workspace",
    kind: "note",
    body,
    authority: "fact",
    trust: "trusted",
    sourceKind: "bot_self",
    by: "test",
    ...over,
  });
}

function draft(entryIds: unknown, extra: { title?: unknown; targetDocumentId?: unknown } = {}) {
  return draftFromObservations(
    f.ctx.memory.entries,
    f.ctx.knowledge,
    {
      tenantId: TENANT(),
      workspaceId: f.a.workspace.id,
      workspaceName: f.a.workspace.name,
      entryIds,
      title: "VendorDB differences",
      ...extra,
    },
    new Date("2026-10-14T00:00:00.000Z"),
  );
}

const published = () =>
  (f.ctx.db.prepare("SELECT COUNT(*) AS n FROM knowledge_docs").get() as { n: number }).n;

describe("A29 drafts from observations", () => {
  it("cites each note in effective-time order and publishes nothing", () => {
    const later = note("VendorDB accepts a duplicate-key INSERT.", {
      effectiveAt: "2026-10-02T00:00:00.000Z",
      observedAt: "2026-10-02T00:00:00.000Z",
    });
    const earlier = note("VendorDB has no LISTEN/NOTIFY.", {
      effectiveAt: "2026-10-01T00:00:00.000Z",
      observedAt: "2026-10-01T00:00:00.000Z",
    });
    const proposal = draft([later.id, earlier.id]);
    expect(proposal.status).toBe("pending");
    expect(proposal.title).toBe("VendorDB differences");
    expect(proposal.body).toContain("- 2026-10-01: VendorDB has no LISTEN/NOTIFY. [1]");
    expect(proposal.body).toContain("- 2026-10-02: VendorDB accepts a duplicate-key INSERT. [2]");
    expect(proposal.body).toContain(`1. Note ${earlier.id} version 1`);
    expect(proposal.citations?.map((c) => [c.entryId, c.entryVersion, c.changed])).toEqual([
      [earlier.id, 1, false],
      [later.id, 1, false],
    ]);
    expect(published()).toBe(0);

    // A note edited after the draft is reported as changed.
    f.ctx.memory.entries.appendVersion(earlier.id, "edit", { body: "VendorDB lacks NOTIFY." }, "h");
    expect(f.ctx.knowledge.proposal(TENANT(), proposal.id).citations?.[0]?.changed).toBe(true);
  });

  it("refuses untrusted, forgotten, superseded, task and foreign notes", () => {
    const untrusted = note("The pricing page lists 3 plans.", { trust: "untrusted" });
    const forgotten = note("The audit is quarterly.");
    f.ctx.memory.entries.tombstone(forgotten.id, "h");
    f.learn(f.run(), [item("The quota page lists 40 seats.")]);
    f.learn(f.run(), [item("The quota page lists 50 seats.")]);
    const superseded = f.ctx.memory.entries
      .list({ workspaceId: f.a.workspace.id })
      .find((e) => e.body === "The quota page lists 40 seats.");
    const task = note("Imported 3 rows.", { scope: "task", threadId: f.a.thread.id });
    const foreign = f.ctx.memory.entries.insert({
      workspaceId: f.b.workspace.id,
      scope: "workspace",
      kind: "note",
      body: "B's secret host is b.internal.",
      authority: "fact",
      trust: "trusted",
      sourceKind: "human",
      by: "h",
    });
    expect(() => draft([untrusted.id])).toThrow(/confirmed by a human/);
    expect(() => draft([forgotten.id])).toThrow(/current workspace or bot notes/);
    expect(() => draft([superseded?.id])).toThrow(/current workspace or bot notes/);
    expect(() => draft([task.id])).toThrow(/current workspace or bot notes/);
    expect(() => draft([foreign.id])).toThrow(/not found/i);
    expect(() => draft([])).toThrow(/Select 1 to 50/);
    expect(() => draft(Array.from({ length: 51 }, (_, i) => `mem_${i}`))).toThrow(/Select 1 to 50/);
    expect(() => draft([untrusted.id, untrusted.id])).toThrow(/twice/);
  });

  it("publishes a draft only through the Admin review", () => {
    const fact = note("VendorDB has no LISTEN/NOTIFY.");
    const proposal = draft([fact.id]);
    const approved = f.ctx.knowledge.review(TENANT(), proposal.id, "approve", "user:admin");
    expect(approved.status).toBe("approved");
    expect(published()).toBe(1);
  });

  it("applies a targeted update only at the version it was drafted against", () => {
    const fact = note("VendorDB has no LISTEN/NOTIFY.");
    const base = f.ctx.knowledge.review(
      TENANT(),
      f.ctx.knowledge.propose(TENANT(), "VendorDB", "# VendorDB\n\nDifferences.\n").id,
      "approve",
      "user:admin",
    );
    const docId = base.documentId ?? "";
    const update = draft([fact.id], { targetDocumentId: docId });
    expect(update).toMatchObject({ targetDocumentId: docId, targetVersion: 1, title: "VendorDB" });
    expect(
      update.body.startsWith("# VendorDB\n\nDifferences.\n\n## Observations (2026-10-14)"),
    ).toBe(true);
    const stale = draft([fact.id], { targetDocumentId: docId });

    f.ctx.knowledge.review(TENANT(), update.id, "approve", "user:admin");
    const document = f.ctx.knowledge.read(TENANT(), docId);
    expect(document.version).toBe(2);
    expect(document.body).toBe(update.body);
    expect(published()).toBe(1);
    expect(() => f.ctx.knowledge.review(TENANT(), stale.id, "approve", "user:admin")).toThrow(
      /changed after this draft/,
    );
    expect(f.ctx.knowledge.proposal(TENANT(), stale.id).status).toBe("pending");
  });
});
