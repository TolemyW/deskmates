// T0 (ADR-0021 amendment 2, item A2a): the dependency-free JSON Schema subset a task's output is
// checked against, and the write-time checks on the schema itself.
import type { TaskOutputSchema } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { OUTPUT_LIMITS, outputErrors, parseOutput, parseOutputSchema } from "./output-schema.js";

const report: TaskOutputSchema = {
  type: "object",
  required: ["ticker", "price", "tags"],
  additionalProperties: false,
  properties: {
    ticker: { type: "string" },
    price: { type: "number" },
    shares: { type: "integer" },
    side: { enum: ["buy", "sell"] },
    note: { type: ["string", "null"] },
    tags: { type: "array", items: { type: "string" } },
    meta: { type: "object", additionalProperties: { type: "boolean" } },
  },
};

describe("outputErrors", () => {
  it.each<[string, TaskOutputSchema, unknown, string[]]>([
    ["empty schema accepts anything", {}, { any: [1, "x"] }, []],
    ["string", { type: "string" }, "x", []],
    ["string mismatch", { type: "string" }, 1, ["output: expected string, got number"]],
    ["number accepts integers", { type: "number" }, 3, []],
    ["integer", { type: "integer" }, 3, []],
    [
      "integer refuses fractions",
      { type: "integer" },
      3.5,
      ["output: expected integer, got number"],
    ],
    ["boolean", { type: "boolean" }, false, []],
    ["null", { type: "null" }, null, []],
    ["array is not object", { type: "object" }, [], ["output: expected object, got array"]],
    ["null is not object", { type: "object" }, null, ["output: expected object, got null"]],
    ["type list", { type: ["string", "null"] }, null, []],
    [
      "type list mismatch",
      { type: ["string", "null"] },
      true,
      ["output: expected string or null, got boolean"],
    ],
    ["enum hit", { enum: ["a", 1, null] }, 1, []],
    ["enum compares deeply", { enum: [{ a: [1, 2] }] }, { a: [1, 2] }, []],
    ["enum miss", { enum: ["a", "b"] }, "c", ['output: must be one of "a", "b"']],
    [
      "items",
      { type: "array", items: { type: "integer" } },
      [1, "2", 3.5],
      ["output[1]: expected integer, got string", "output[2]: expected integer, got number"],
    ],
    [
      "full report passes",
      report,
      { ticker: "ACME", price: 12.5, tags: [], side: "buy", note: null, meta: { ok: true } },
      [],
    ],
    [
      "required and nested failures are all reported",
      report,
      { price: "12", tags: [1], extra: 1, meta: { ok: "yes" } },
      [
        "output: missing required property ticker",
        "output.price: expected number, got string",
        "output.tags[0]: expected string, got number",
        "output.meta.ok: expected boolean, got string",
        "output: unexpected property extra",
      ],
    ],
    ["required without type does not apply to non-objects", { required: ["a"] }, "plain", []],
  ])("%s", (_name, schema, value, errors) => {
    expect(outputErrors(schema, value)).toEqual(errors);
  });

  it("caps the number of reported errors", () => {
    const errors = outputErrors(
      { type: "array", items: { type: "string" } },
      Array.from({ length: 100 }, (_, i) => i),
    );
    expect(errors).toHaveLength(OUTPUT_LIMITS.errors);
    expect(errors.at(-1)).toMatch(/more errors not shown/);
  });
});

describe("parseOutputSchema", () => {
  it("accepts the supported subset and annotations", () => {
    expect(parseOutputSchema(report)).toEqual(report);
    expect(
      parseOutputSchema({ title: "T", description: "D", $schema: "x", type: "object" }),
    ).toMatchObject({ title: "T" });
  });

  it.each<[string, unknown, RegExp]>([
    ["not an object", [], /must be a JSON object/],
    ["null", null, /must be a JSON object/],
    ["unsupported keyword", { type: "string", minLength: 3 }, /Unsupported .*minLength/],
    [
      "nested unsupported keyword",
      { properties: { a: { pattern: "^x" } } },
      /Unsupported .*pattern.*properties\.a/,
    ],
    ["unknown type", { type: "date" }, /type/],
    ["empty type list", { type: [] }, /type/],
    ["duplicate types", { type: ["string", "string"] }, /type/],
    ["required not strings", { required: [1] }, /required/],
    ["duplicate required", { required: ["a", "a"] }, /required/],
    ["properties not an object", { properties: [] }, /properties/],
    ["property schema not an object", { properties: { a: 1 } }, /must be a JSON object/],
    ["empty enum", { enum: [] }, /enum/],
    ["tuple items", { items: [{ type: "string" }] }, /must be a JSON object/],
    ["additionalProperties string", { additionalProperties: "no" }, /additionalProperties/],
    ["title not a string", { title: 1 }, /title/],
    ["too large", { description: "x".repeat(OUTPUT_LIMITS.schemaBytes) }, /at most 16384 bytes/],
    [
      "too deep",
      Array.from({ length: OUTPUT_LIMITS.depth + 1 }).reduce<Record<string, unknown>>(
        (inner) => ({ items: inner }),
        {},
      ),
      /nested/,
    ],
  ])("refuses %s", (_name, raw, message) => {
    expect(() => parseOutputSchema(raw)).toThrowError(
      expect.objectContaining({ code: "validation", message: expect.stringMatching(message) }),
    );
  });
});

describe("parseOutput", () => {
  it("accepts JSON values within the size bound", () => {
    expect(parseOutput({ a: [1, "b", null, true] })).toEqual({ a: [1, "b", null, true] });
    expect(parseOutput(0)).toBe(0);
  });

  it("refuses an oversized output", () => {
    expect(() => parseOutput("x".repeat(OUTPUT_LIMITS.outputBytes))).toThrowError(
      expect.objectContaining({ code: "validation" }),
    );
  });
});
