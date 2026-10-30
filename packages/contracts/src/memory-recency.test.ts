// T0 (ADR-0011 amendment 2, Verification A7 and A9): the fact key and the recency order are pure,
// deterministic functions. Same key = same fact; the value is the numbers and the polarity.

import { describe, expect, it } from "vitest";
import {
  compareRecency,
  memoryEffectiveTime,
  memoryFact,
  memoryValuesEquivalent,
} from "./memory-recency.js";

describe("memoryFact (A7)", () => {
  const same: [string, string, string][] = [
    ["a new number", "The quota page lists 40 seats.", "The quota page lists 50 seats."],
    [
      "a new polarity",
      "The export button is under Reports.",
      "The export button is not under Reports.",
    ],
    [
      "a dropped ISO date",
      "As of 2026-09-01 the limit is 20.",
      "As of 2026-10-01T10:00:00Z the limit is 25.",
    ],
    ["case and punctuation", "VendorDB rejects duplicate keys.", "vendordb rejects duplicate keys"],
  ];
  it.each(same)("treats %s as the same fact", (_name, a, b) => {
    expect(memoryFact(a).key).toBeDefined();
    expect(memoryFact(a).key).toBe(memoryFact(b).key);
  });

  const different: [string, string, string][] = [
    ["another subject", "The quota page lists 40 seats.", "The billing page lists 40 seats."],
    [
      "another property",
      "The case_id field accepts 20 characters.",
      "The case_id field rejects 20 characters.",
    ],
    ["a product version", "PostgreSQL 15 rejects the INSERT.", "PostgreSQL 16 rejects the INSERT."],
    ["a version condition", "In version 2 the limit is 20.", "In version 3 the limit is 20."],
    ["a named version", "Node v18 ships fetch.", "Node v16 ships fetch."],
  ];
  it.each(different)("keeps %s apart", (_name, a, b) => {
    expect(memoryFact(a).key).not.toBe(memoryFact(b).key);
  });

  it("separates the value from the key", () => {
    expect(memoryFact("The quota page lists 40 seats.").value).toBe("is|40");
    expect(memoryFact("The export button is not under Reports.").value).toBe("not|");
    expect(memoryFact("PostgreSQL 15 caps names at 63 bytes.").value).toBe("is|63");
  });

  it("does not take a sentence-initial stopword for a product name", () => {
    expect(memoryFact("The 20 seats are full.").value).toBe("is|20");
  });

  it("has no key for a body without content words", () => {
    expect(memoryFact("It is 42.").key).toBeUndefined();
  });
});

describe("multi-number value consolidation (ADR-0054)", () => {
  it.each([
    ["Current quota is 300, replacing 280.", "Current quota is 280, replacing 300."],
    ["项目当前目标为300单，替代原280单。", "项目当前目标为280单，替代原300单。"],
    ["Seats cost 20; rooms cost 30.", "Rooms cost 20; seats cost 30."],
    ["Quota page lists 20 seats and 20 rooms.", "Quota page lists 20 rooms and 20 seats."],
    ["The quota lists 20 seats and 20 rooms.", "The quota lists 20 seats and rooms."],
  ])("does not merge numeric roles in %s", (a, b) => {
    expect(memoryFact(a)).toEqual(memoryFact(b));
    expect(memoryValuesEquivalent(a, b)).toBe(false);
    expect(memoryValuesEquivalent(b, a)).toBe(false);
  });

  it.each([
    ["Current quota is 300, replacing 280.", "  Current  quota is ３００, replacing ２８０！ "],
    ["The quota lists 40 seats.", "40 seats the quota lists"],
    ["The export button is under Reports.", "Under Reports is the export button"],
    ["In version 2 the quota lists 40 seats.", "The quota lists 40 seats in version 2"],
    ["As of 2026-10-22 the quota lists 40 seats.", "As of 2026-10-23 the quota lists 40 seats"],
  ])("keeps normalized copies or a single value equivalent: %s", (a, b) => {
    expect(memoryFact(a)).toEqual(memoryFact(b));
    expect(memoryValuesEquivalent(a, b)).toBe(true);
  });

  it("still distinguishes changed single numbers and polarity", () => {
    expect(memoryValuesEquivalent("Quota is 40.", "Quota is 50.")).toBe(false);
    expect(memoryValuesEquivalent("Export is available.", "Export is not available.")).toBe(false);
  });
});

describe("memoryEffectiveTime (A9)", () => {
  const run = "2026-10-13T10:00:00.000Z";
  const received = "2026-10-13T11:00:00.000Z";

  it("accepts a sidecar stamp inside the run's lifetime", () => {
    expect(
      memoryEffectiveTime({
        stampedAt: "2026-10-13T10:30:00.000Z",
        runCreatedAt: run,
        receivedAt: received,
      }),
    ).toEqual({ at: "2026-10-13T10:30:00.000Z", basis: "source" });
  });

  it("clamps a future stamp to the time of receipt", () => {
    expect(
      memoryEffectiveTime({
        stampedAt: "2027-01-01T00:00:00.000Z",
        runCreatedAt: run,
        receivedAt: received,
      }),
    ).toEqual({ at: received, basis: "source", clamped: "future" });
  });

  it("clamps a stamp from before the run to the run's creation", () => {
    expect(
      memoryEffectiveTime({
        stampedAt: "2020-01-01T00:00:00.000Z",
        runCreatedAt: run,
        receivedAt: received,
      }),
    ).toEqual({ at: run, basis: "source", clamped: "before_run" });
  });

  it("falls back to the run's creation, then to receipt", () => {
    expect(memoryEffectiveTime({ runCreatedAt: run, receivedAt: received })).toEqual({
      at: run,
      basis: "run",
    });
    expect(memoryEffectiveTime({ stampedAt: "not a time", receivedAt: received })).toEqual({
      at: received,
      basis: "ingest",
    });
  });
});

describe("compareRecency (A9)", () => {
  const at = (effectiveAt: string, ingestedAt: string, id: string) => ({
    effectiveAt,
    ingestedAt,
    id,
  });
  const t1 = "2026-10-13T10:00:00.000Z";
  const t2 = "2026-10-13T11:00:00.000Z";

  it.each([
    [
      "a newer effective time wins",
      at(t2, t1, "mem_a"),
      at(t1, t2, "mem_b"),
      true,
      "newer_effective_time",
    ],
    [
      "a late older arrival loses",
      at(t1, t2, "mem_a"),
      at(t2, t1, "mem_b"),
      false,
      "older_arrival",
    ],
    [
      "equal times: later ingestion wins",
      at(t1, t2, "mem_a"),
      at(t1, t1, "mem_b"),
      true,
      "tie_later_ingestion",
    ],
    [
      "equal everything: the larger id wins",
      at(t1, t1, "mem_b"),
      at(t1, t1, "mem_a"),
      true,
      "tie_entry_id",
    ],
    [
      "equal everything: the smaller id loses",
      at(t1, t1, "mem_a"),
      at(t1, t1, "mem_b"),
      false,
      "older_arrival",
    ],
  ] as const)("%s", (_name, incoming, current, incomingWins, reason) => {
    expect(compareRecency(incoming, current)).toEqual({ incomingWins, reason });
  });

  it("answers every pair one way", () => {
    const a = at(t1, t1, "mem_a");
    const b = at(t1, t1, "mem_b");
    expect(compareRecency(a, b).incomingWins).toBe(!compareRecency(b, a).incomingWins);
  });
});
