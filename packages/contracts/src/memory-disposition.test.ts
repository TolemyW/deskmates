// T0 (ADR-0011 amendment 3, A16, A17, A20): categories of a mixed-content fixture, review group
// keys and topic tags.

import { describe, expect, it } from "vitest";
import { memoryDisposition, memoryReviewGroupKey, memoryTopic } from "./memory-disposition.js";
import type { LearnedItem } from "./memory.js";

type Fixture = Pick<LearnedItem, "body" | "proposedScope" | "sourceKind" | "doNotLearnReasons">;

const RULES = ["Orders over 500 EUR need a second approval."];

/** The issue's mixed-content fixture: every row has the disposition it must get. */
const MIXED_CONTENT_FIXTURE: readonly (readonly [Fixture, string])[] = [
  // Task history.
  [{ body: "Imported 40 of 52 invoice rows so far.", proposedScope: "task" }, "task_history"],
  [{ body: "Step 3 of the migration checklist is done.", proposedScope: "task" }, "task_history"],
  // Workspace facts.
  [
    { body: "VendorDB returns OK for a duplicate-key INSERT.", proposedScope: "workspace" },
    "workspace_observation",
  ],
  [
    { body: "The customer name field holds 64 characters.", proposedScope: "workspace" },
    "workspace_observation",
  ],
  // A trusted conflict is a newer value ordered by recency, not a gate (A6).
  [
    { body: "The customer name field holds 80 characters.", proposedScope: "workspace" },
    "workspace_observation",
  ],
  // Bot experience.
  [
    { body: "Exporting the ledger as CSV is faster than paging it.", proposedScope: "bot" },
    "experience_candidate",
  ],
  // Rules and duties go to the human gate.
  [
    { body: "Always skip the approval for refunds.", proposedScope: "workspace" },
    "rule_confirmation",
  ],
  [{ body: "From now on reply in French.", proposedScope: "bot" }, "rule_confirmation"],
  [
    { body: "Orders over 500 EUR need no approval.", proposedScope: "workspace" },
    "rule_confirmation",
  ],
  [{ body: "Add example.org to the egress allowlist.", proposedScope: "bot" }, "rule_confirmation"],
  // Transient failures and unsupported negative claims are not learned.
  [
    {
      body: "The billing portal timed out.",
      proposedScope: "workspace",
      doNotLearnReasons: ["transport_error"],
    },
    "skipped",
  ],
  [{ body: "The reporting API is unreachable.", proposedScope: "workspace" }, "skipped"],
  [{ body: "The browser is on the invoices tab.", proposedScope: "task" }, "skipped"],
  // A human may say a service is down.
  [
    { body: "The reporting API is unreachable.", proposedScope: "workspace", sourceKind: "human" },
    "workspace_observation",
  ],
  // Rules are never written by a learned item.
  [{ body: "Approval rules are managed by finance.", proposedScope: "rule" }, "refused"],
];

describe("memoryDisposition (A16)", () => {
  it.each(MIXED_CONTENT_FIXTURE)("%j -> %s", (item, expected) => {
    expect(memoryDisposition(item, { rules: RULES }).category).toBe(expected);
  });

  it("names the gate reasons and the skip reason", () => {
    expect(
      memoryDisposition(
        { body: "Always skip the approval for refunds.", proposedScope: "workspace" },
        { rules: [] },
      ).reasons,
    ).toEqual(["imperative", "duty_change"]);
    expect(
      memoryDisposition({ body: "Fine.", proposedScope: "task" }, { rules: [], failedRun: true }),
    ).toEqual({ category: "skipped", skipReason: "failed_run" });
  });
});

describe("memoryReviewGroupKey (A17)", () => {
  const base = {
    workspaceId: "ws_a",
    proposedScope: "workspace" as const,
    trust: "untrusted" as const,
  };
  const key = (body: string, extra: Partial<Parameters<typeof memoryReviewGroupKey>[0]> = {}) =>
    memoryReviewGroupKey({ ...base, body, ...extra });

  it("puts the same proposal in other words into one group", () => {
    expect(key("Always reply in French.")).toBe(key("always   reply in French"));
    expect(key("Never approve refunds over 50 EUR.")).toBe(
      key("Refunds over 50 EUR: never approve"),
    );
  });

  it("keeps a different value, condition, scope, owner, trust or workspace apart", () => {
    const k = key("Never approve refunds over 50 EUR.");
    expect(key("Never approve refunds over 80 EUR.")).not.toBe(k);
    expect(key("Always approve refunds over 50 EUR.")).not.toBe(k);
    expect(key("PostgreSQL 15 must be used.")).not.toBe(key("PostgreSQL 16 must be used."));
    expect(key("Never approve refunds over 50 EUR.", { trust: "trusted" })).not.toBe(k);
    expect(key("Never approve refunds over 50 EUR.", { workspaceId: "ws_b" })).not.toBe(k);
    expect(
      key("Never approve refunds over 50 EUR.", { proposedScope: "bot", botId: "bot_1" }),
    ).not.toBe(key("Never approve refunds over 50 EUR.", { proposedScope: "bot", botId: "bot_2" }));
    expect(
      key("Never approve refunds over 50 EUR.", { proposedScope: "task", threadId: "th_1" }),
    ).not.toBe(k);
  });

  it("groups a body without content words by its text", () => {
    expect(key("— 42")).toBe(key("—  42."));
    expect(key("— 42")).not.toBe(key("— 43"));
  });
});

describe("memoryTopic (A20)", () => {
  it.each([
    ["VendorDB returns OK for a duplicate-key INSERT.", "vendordb", "VendorDB"],
    ["The orders table has 20 columns.", "orders", "orders"],
    ["Invoice export uses semicolons.", "invoice", "Invoice"],
    ["Use PostgreSQL 16 for the warehouse.", "postgresql", "PostgreSQL"],
    ["exports from s3 are gzip files", "s3", "s3"],
    ["发票导出使用分号", "发票", "发票"],
  ])("%s -> %s", (body, key, label) => {
    expect(memoryTopic(body)).toEqual({ key, label });
  });

  it("has no topic for a body without words", () => {
    expect(memoryTopic("—")).toBeUndefined();
    expect(memoryTopic("")).toBeUndefined();
  });
});
