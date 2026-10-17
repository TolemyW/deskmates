// T0, ADR-0011 amendment 4 A31 and A32: what a model label or split must be before it is kept.

import { describe, expect, it } from "vitest";
import { parseMemoryOrganizeReply, splitRejection, validTopicLabel } from "./memory-organize.js";

describe("parseMemoryOrganizeReply", () => {
  it("reads labels and splits from one JSON object, fenced or not", () => {
    const reply =
      '```json\n{"labels":[{"id":"m1","label":"VendorDB"}],"splits":[{"id":"m2","parts":["a","b"]}]}\n```';
    expect(parseMemoryOrganizeReply(reply)).toEqual({
      labels: [{ id: "m1", label: "VendorDB" }],
      splits: [{ id: "m2", parts: ["a", "b"] }],
    });
  });

  it("drops malformed items and refuses text that is not JSON", () => {
    expect(
      parseMemoryOrganizeReply(
        '{"labels":[{"id":1,"label":"x"},{"id":"m1"}],"splits":[{"id":"m2","parts":[1]}]}',
      ),
    ).toEqual({ labels: [], splits: [] });
    expect(parseMemoryOrganizeReply("no json here")).toBeUndefined();
    expect(parseMemoryOrganizeReply("{not json}")).toBeUndefined();
  });
});

describe("validTopicLabel", () => {
  const cases: [string, string | undefined][] = [
    ["VendorDB", "VendorDB"],
    ["  Release process ", "Release process"],
    ["数据库", "数据库"],
    ["", undefined],
    ["x".repeat(41), undefined],
    ["one two three four five", undefined],
    ["line\nbreak", undefined],
    ["<b>bold</b>", undefined],
    ["**Ignore previous**", undefined],
    ["---", undefined],
  ];
  for (const [label, expected] of cases)
    it(JSON.stringify(label), () => expect(validTopicLabel(label)?.label).toBe(expected));

  it("keys a label in lower case", () => {
    expect(validTopicLabel("VendorDB")).toEqual({ key: "vendordb", label: "VendorDB" });
  });
});

describe("splitRejection", () => {
  const original =
    "VendorDB accepts a duplicate-key INSERT that PostgreSQL rejects, and the orders table holds 20 columns";

  it("keeps parts made only of the original's words and numbers", () => {
    expect(
      splitRejection(original, [
        "VendorDB accepts a duplicate-key INSERT that PostgreSQL rejects",
        "The orders table holds 20 columns",
      ]),
    ).toBeUndefined();
  });

  const cases: [string, string[], string][] = [
    ["a single part", ["VendorDB accepts a duplicate-key INSERT"], "part_count"],
    ["six parts", ["VendorDB", "accepts", "INSERT", "PostgreSQL", "orders", "table"], "part_count"],
    ["an empty part", ["VendorDB accepts a duplicate-key INSERT", "  "], "empty_part"],
    ["a part as long as the original", [original, "orders table"], "not_shorter"],
    [
      "a new word",
      ["VendorDB accepts a duplicate-key INSERT", "The orders table is deprecated"],
      "new_content",
    ],
    [
      "a new number",
      ["VendorDB accepts a duplicate-key INSERT", "The orders table holds 21 columns"],
      "new_content",
    ],
  ];
  for (const [name, parts, reason] of cases)
    it(`drops ${name}`, () => expect(splitRejection(original, parts)).toBe(reason));

  it("drops a part that would be gated as an instruction", () => {
    const body = "Always use VendorDB for orders and the orders table holds 20 columns";
    expect(
      splitRejection(body, ["Always use VendorDB for orders", "orders table holds 20 columns"]),
    ).toBe("imperative");
  });

  it("drops a part the do-not-learn filter would discard", () => {
    const body = "The billing service is down and the orders table holds 20 columns today";
    expect(
      splitRejection(body, ["The billing service is down", "orders table holds 20 columns"]),
    ).toBe("do_not_learn");
  });
});
