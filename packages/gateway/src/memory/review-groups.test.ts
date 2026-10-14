// T1 (ADR-0011 amendment 3, A16 to A19): categories applied by the learned write, review groups
// of gated items, bounded batch dispositions with preview tokens, audit and undo.

import { memoryDisposition, memoryFact } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { type MemoryFixture, item, memoryFixture } from "../test-support/memory-fixture.js";
import { commitBatch, listReviewGroups, previewBatch, undoBatch } from "./review-groups.js";

let f: MemoryFixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const RULE = "Always reply to customers in French.";

function gateFromRuns(fx: MemoryFixture, bodies: readonly string[], trust = "trusted" as const) {
  for (const body of bodies) fx.learn(fx.run(), [item(body, { trust })]);
}

function audits(fx: MemoryFixture, action: string): number {
  return (
    fx.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = ?").get(action) as {
      n: number;
    }
  ).n;
}

describe("A16 categories", () => {
  it("gives every fixture item the outcome its category names", async () => {
    f = await memoryFixture();
    const fixture = [
      item("Imported 40 of 52 invoice rows so far.", { proposedScope: "task" }),
      item("VendorDB returns OK for a duplicate-key INSERT."),
      item("Exporting the ledger as CSV is faster than paging it.", { proposedScope: "bot" }),
      item("Always skip the approval for refunds."),
      item("The reporting API is unreachable."),
      item("The browser is on the invoices tab.", { proposedScope: "task" }),
      item("Approval rules are managed by finance.", { proposedScope: "rule" }),
    ];
    const outcomes = f.learn(f.run(), fixture);
    const expected = {
      task_history: "applied",
      workspace_observation: "applied",
      experience_candidate: "applied",
      rule_confirmation: "gated",
      skipped: "skipped",
      refused: "refused",
    } as const;
    fixture.forEach((it, i) => {
      const category = memoryDisposition(it, {
        rules: f?.ctx.memory.rulesFor(f.a.bot.id) ?? [],
      }).category;
      expect([it.body, outcomes[i]?.outcome]).toEqual([it.body, expected[category]]);
    });
  });
});

describe("A17 review groups", () => {
  it("puts one proposal from three runs in one group and keeps different ones apart", async () => {
    f = await memoryFixture();
    gateFromRuns(f, [
      RULE,
      "always reply to customers in french",
      "Always  reply to customers in French!",
    ]);
    gateFromRuns(f, ["Always reply to customers in German."]);
    gateFromRuns(f, [RULE], "untrusted" as never);
    f.learn(f.run("b"), [item(RULE)]);
    const page = listReviewGroups(f.ctx.memory.stores, f.a.workspace.id, { limit: 10 });
    expect(page.totalGroups).toBe(3);
    expect(page.totalItems).toBe(5);
    const french = page.groups.find((g) => g.count === 3);
    // Every wording is kept (rows gated in one millisecond tie on time; compare as a set).
    expect(french?.items.map((i) => i.body).sort()).toEqual(
      [RULE, "always reply to customers in french", "Always  reply to customers in French!"].sort(),
    );
    expect(new Set(french?.items.map((i) => i.runId)).size).toBe(3);
    expect(page.groups.map((g) => g.trust).sort()).toEqual(["trusted", "trusted", "untrusted"]);
    // The other workspace's identical proposal is its own group, never in this list.
    expect(listReviewGroups(f.ctx.memory.stores, f.b.workspace.id, { limit: 10 }).totalItems).toBe(
      1,
    );
  });

  it("backfills rows gated before amendment 3", async () => {
    f = await memoryFixture();
    gateFromRuns(f, [RULE, RULE]);
    f.ctx.db.prepare("UPDATE memory_suggestions SET group_key = NULL").run();
    const page = listReviewGroups(f.ctx.memory.stores, f.a.workspace.id, { limit: 10 });
    expect(page.groups).toHaveLength(1);
    expect(page.groups[0]?.count).toBe(2);
  });
});

describe("A18 batch dispositions", () => {
  it("merges a group into one trusted note with every run as a source", async () => {
    f = await memoryFixture();
    gateFromRuns(f, [RULE, RULE, RULE], "untrusted" as never);
    const stores = f.ctx.memory.stores;
    const group = listReviewGroups(stores, f.a.workspace.id, { limit: 10 }).groups[0];
    const preview = previewBatch(stores, f.a.workspace.id, group?.groupKey ?? "", "merge");
    expect(preview.itemIds).toHaveLength(3);
    expect(preview.representativeId).toBe(preview.itemIds[0]);
    const input = {
      workspaceId: f.a.workspace.id,
      groupKey: preview.groupKey,
      decision: "merge",
      token: preview.token,
      by: "human:owner",
    };
    const batch = commitBatch(stores, f.ctx.audit, input);
    expect(batch.createdEntry).toBe(true);
    const entry = stores.entries.mustGet(batch.entryId ?? "");
    expect(entry.trust).toBe("trusted");
    expect(entry.sourceKind).toBe("human");
    const sources = stores.entries.sources(f.a.workspace.id, entry.id);
    expect(sources).toHaveLength(3);
    // Copies keep their own trust as sources; the note's trust is the human decision's.
    expect(sources.slice(1).map((s) => s.trust)).toEqual(["untrusted", "untrusted"]);
    expect(
      preview.itemIds.map((id) => stores.confirmations.get(id)).map((s) => [s.status, s.entryId]),
    ).toEqual(preview.itemIds.map(() => ["applied", entry.id]));
    // Idempotent per token: the same commit returns the same batch and writes nothing new.
    expect(commitBatch(stores, f.ctx.audit, input).id).toBe(batch.id);
    expect(audits(f, "memory.review_batch")).toBe(1);
  });

  it("refuses a stale preview and writes nothing", async () => {
    f = await memoryFixture();
    gateFromRuns(f, [RULE, RULE]);
    const stores = f.ctx.memory.stores;
    const key = listReviewGroups(stores, f.a.workspace.id, { limit: 10 }).groups[0]?.groupKey ?? "";
    const preview = previewBatch(stores, f.a.workspace.id, key, "reject");
    stores.confirmations.reject(preview.itemIds[1] ?? "", "human:other");
    expect(() =>
      commitBatch(stores, f?.ctx.audit as never, {
        workspaceId: f?.a.workspace.id as never,
        groupKey: key,
        decision: "reject",
        token: preview.token,
        by: "human:owner",
      }),
    ).toThrow(/changed since the preview/);
    expect(stores.confirmations.get(preview.itemIds[0] ?? "").status).toBe("pending");
    expect(audits(f, "memory.review_batch")).toBe(0);
  });

  it("decides at most 50 items and leaves the rest pending", async () => {
    f = await memoryFixture();
    gateFromRuns(
      f,
      Array.from({ length: 51 }, () => RULE),
    );
    const stores = f.ctx.memory.stores;
    const key = listReviewGroups(stores, f.a.workspace.id, { limit: 10 }).groups[0]?.groupKey ?? "";
    const preview = previewBatch(stores, f.a.workspace.id, key, "reject");
    expect(preview.itemIds).toHaveLength(50);
    expect(preview.remaining).toBe(1);
    commitBatch(stores, f.ctx.audit, {
      workspaceId: f.a.workspace.id,
      groupKey: key,
      decision: "reject",
      token: preview.token,
      by: "human:owner",
    });
    expect(listReviewGroups(stores, f.a.workspace.id, { limit: 10 }).totalItems).toBe(1);
  });

  it("finds no group of another workspace", async () => {
    f = await memoryFixture();
    gateFromRuns(f, [RULE]);
    const stores = f.ctx.memory.stores;
    const key = listReviewGroups(stores, f.a.workspace.id, { limit: 10 }).groups[0]?.groupKey ?? "";
    expect(() => previewBatch(stores, f?.b.workspace.id as never, key, "reject")).toThrow(
      /No pending items/,
    );
  });
});

describe("A19 undo", () => {
  it("returns a rejected group to pending, once", async () => {
    f = await memoryFixture();
    gateFromRuns(f, [RULE, RULE]);
    const stores = f.ctx.memory.stores;
    const key = listReviewGroups(stores, f.a.workspace.id, { limit: 10 }).groups[0]?.groupKey ?? "";
    const preview = previewBatch(stores, f.a.workspace.id, key, "reject");
    const batch = commitBatch(stores, f.ctx.audit, {
      workspaceId: f.a.workspace.id,
      groupKey: key,
      decision: "reject",
      token: preview.token,
      by: "human:owner",
    });
    const undo = { workspaceId: f.a.workspace.id, batchId: batch.id, by: "human:owner" };
    expect(undoBatch(stores, f.ctx.audit, undo).undoneBy).toBe("human:owner");
    expect(listReviewGroups(stores, f.a.workspace.id, { limit: 10 }).totalItems).toBe(2);
    expect(() => undoBatch(stores, f?.ctx.audit as never, undo)).toThrow(/already undone/);
    expect(audits(f, "memory.review_batch_undo")).toBe(1);
  });

  it("forgets the merged note and restores the note it replaced", async () => {
    f = await memoryFixture();
    const stores = f.ctx.memory.stores;
    // A current note of the same fact (written by an operator, so not gated) that the merged
    // rule-shaped note replaces.
    const olderBody = "Customers must get replies in French within 2 days.";
    const older = stores.entries.insert({
      workspaceId: f.a.workspace.id,
      scope: "workspace",
      kind: "note",
      body: olderBody,
      authority: "fact",
      trust: "trusted",
      sourceKind: "human",
      factKey: memoryFact(olderBody).key as string,
      effectiveAt: "2026-01-01T00:00:00.000Z",
      by: "human:o",
    });
    gateFromRuns(f, [
      "Customers must get replies in French within 1 days.",
      "Customers must get replies in French within 1 days.",
    ]);
    const key = listReviewGroups(stores, f.a.workspace.id, { limit: 10 }).groups[0]?.groupKey ?? "";
    const preview = previewBatch(stores, f.a.workspace.id, key, "merge");
    const batch = commitBatch(stores, f.ctx.audit, {
      workspaceId: f.a.workspace.id,
      groupKey: key,
      decision: "merge",
      token: preview.token,
      by: "human:owner",
    });
    const merged = stores.entries.mustGet(batch.entryId ?? "");
    const replaced = stores.entries.mustGet(older?.id ?? "");
    expect(replaced.invalidAt).toBeDefined();
    expect(merged.factKey).toBe(replaced.factKey);
    undoBatch(stores, f.ctx.audit, {
      workspaceId: f.a.workspace.id,
      batchId: batch.id,
      by: "human:owner",
    });
    expect(stores.entries.mustGet(merged.id).tombstoned).toBe(true);
    expect(stores.entries.mustGet(merged.id).body).toBe("");
    expect(stores.entries.mustGet(replaced.id).invalidAt).toBeUndefined();
    expect(preview.itemIds.map((id) => stores.confirmations.get(id).status)).toEqual([
      "pending",
      "pending",
    ]);
  });

  it("refuses to undo a merge whose note was edited since", async () => {
    f = await memoryFixture();
    gateFromRuns(f, [RULE, RULE]);
    const stores = f.ctx.memory.stores;
    const key = listReviewGroups(stores, f.a.workspace.id, { limit: 10 }).groups[0]?.groupKey ?? "";
    const preview = previewBatch(stores, f.a.workspace.id, key, "merge");
    const batch = commitBatch(stores, f.ctx.audit, {
      workspaceId: f.a.workspace.id,
      groupKey: key,
      decision: "merge",
      token: preview.token,
      by: "human:owner",
    });
    stores.entries.appendVersion(batch.entryId ?? "", "edit", { body: "Reply in French." }, "h");
    expect(() =>
      undoBatch(stores, f?.ctx.audit as never, {
        workspaceId: f?.a.workspace.id as never,
        batchId: batch.id,
        by: "human:owner",
      }),
    ).toThrow(/changed since/);
  });
});
