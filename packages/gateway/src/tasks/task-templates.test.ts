// T0 (ADR-0021 amendment 4, A4a to A4c): the built-in templates, the template input check, the
// field values a create stores and the section a templated create appends to the description.

import { describe, expect, it } from "vitest";
import { BUILTIN_TEMPLATES, builtinTemplate, isBuiltinKind } from "./builtin-templates.js";
import {
  fieldValues,
  normalizeFieldValue,
  stampOf,
  templateBrief,
  templateInput,
} from "./task-templates.js";

const minimal = {
  kind: "invoice-check",
  name: "Invoice check",
  stages: [{ key: "check", name: "Check", criteria: ["Totals match the order"] }],
};

describe("built-ins (A4b)", () => {
  it("offers the four coordinator-chosen kinds with labelled criteria and their settings", () => {
    expect(BUILTIN_TEMPLATES.map((t) => [t.kind, t.review, t.slaMinutes])).toEqual([
      ["support-ticket", "human", 1440],
      ["research-report", "peer_bot", null],
      ["coding-task", "peer_bot", null],
      ["functional-test", "human", null],
    ]);
    const support = builtinTemplate("builtin:support-ticket");
    expect(support?.stages.map((s) => [s.key, s.checkpointRequired])).toEqual([
      ["triage", true],
      ["resolve", true],
      ["confirm", false],
    ]);
    expect(support?.stages[0]?.criteria.map((c) => c.label)).toEqual(["triage.1", "triage.2"]);
    expect(support?.fields.map((f) => [f.key, f.required, f.defaultValue, f.relates])).toEqual([
      ["customer", true, "", true],
      ["channel", false, "web", false],
      ["priority", false, "P3", false],
    ]);
    const research = builtinTemplate("builtin:research-report");
    expect(research?.stages.map((s) => s.key)).toEqual([
      "discovery",
      "draft",
      "peer-review",
      "deliver",
    ]);
    expect(research?.stages[0]?.criteria[0]?.text).toContain("At least 10 distinct sources");
    expect(builtinTemplate("builtin:coding-task")?.stages.map((s) => s.key)).toEqual([
      "plan",
      "implement",
      "tests",
      "review",
      "deliver",
    ]);
    expect(builtinTemplate("builtin:functional-test")?.stages.map((s) => s.key)).toEqual([
      "plan-cases",
      "execute",
      "report",
    ]);
    for (const t of BUILTIN_TEMPLATES) {
      expect(t.builtIn).toBe(true);
      expect(t.id).toBe(`builtin:${t.kind}`);
      // Every built-in passes the same check an Admin's template does.
      expect(() =>
        templateInput({
          kind: `${t.kind}-copy`,
          name: t.name,
          description: t.description,
          review: t.review,
          slaMinutes: t.slaMinutes,
          fields: t.fields,
          stages: t.stages.map((s) => ({
            key: s.key,
            name: s.name,
            checkpointRequired: s.checkpointRequired,
            criteria: s.criteria.map((c) => c.text),
          })),
        }),
      ).not.toThrow();
    }
    expect(isBuiltinKind("support-ticket")).toBe(true);
    expect(isBuiltinKind("invoice-check")).toBe(false);
  });
});

describe("templateInput (A4a)", () => {
  it("assigns criterion labels and defaults", () => {
    const t = templateInput(minimal);
    expect(t).toEqual({
      kind: "invoice-check",
      name: "Invoice check",
      description: "",
      review: "none",
      slaMinutes: null,
      fields: [],
      stages: [
        {
          key: "check",
          name: "Check",
          checkpointRequired: false,
          criteria: [{ label: "check.1", text: "Totals match the order" }],
        },
      ],
    });
  });

  it("refuses unknown properties, bad keys, repeats and bounds", () => {
    const bad: unknown[] = [
      { ...minimal, extra: 1 },
      { ...minimal, kind: "Invoice Check" },
      { ...minimal, stages: [] },
      { ...minimal, stages: [{ key: "check", name: "x", criteria: [] }] },
      { ...minimal, stages: [minimal.stages[0], minimal.stages[0]] },
      { ...minimal, review: "manager" },
      { ...minimal, slaMinutes: 0 },
      { ...minimal, slaMinutes: 1.5 },
      { ...minimal, fields: [{ key: "Customer", label: "Customer" }] },
      {
        ...minimal,
        fields: [
          { key: "a", label: "A" },
          { key: "a", label: "B" },
        ],
      },
      { ...minimal, fields: [{ key: "a", label: "A", relates: "yes" }] },
      { ...minimal, stages: [{ key: "check", name: "x", criteria: ["y".repeat(501)] }] },
    ];
    for (const body of bad) expect(() => templateInput(body), JSON.stringify(body)).toThrow();
  });
});

describe("field values (A4c)", () => {
  const defs = builtinTemplate("builtin:support-ticket")?.fields ?? [];

  it("fills defaults, requires required fields and refuses unknown ones", () => {
    expect(fieldValues(defs, { customer: "ACME Corp" }, { fillDefaults: true })).toEqual({
      customer: "ACME Corp",
      channel: "web",
      priority: "P3",
    });
    expect(() => fieldValues(defs, {}, { fillDefaults: true })).toThrow(/Customer is required/);
    expect(() =>
      fieldValues(defs, { customer: "x", plan: "gold" }, { fillDefaults: true }),
    ).toThrow(/Unknown field: plan/);
    expect(() =>
      fieldValues(defs, { customer: "x".repeat(201) }, { fillDefaults: true }),
    ).toThrow();
    // A correction names only what changes.
    expect(fieldValues(defs, { priority: "P1" }, { fillDefaults: false })).toEqual({
      priority: "P1",
    });
  });

  it("normalises values for equal-value matching", () => {
    expect(normalizeFieldValue("  ACME   Corp ")).toBe("acme corp");
  });
});

describe("template section (A4c, A4d)", () => {
  it("lists the stages, labelled criteria, fields, target and review in plain text", () => {
    const support = builtinTemplate("builtin:support-ticket");
    if (!support) throw new Error("missing built-in");
    const brief = templateBrief(stampOf(support), {
      customer: "ACME",
      channel: "web",
      priority: "P2",
    });
    expect(brief.split("\n")[0]).toBe(
      "--- Template: Customer support ticket (kind support-ticket, version 1)",
    );
    expect(brief).toContain("Fields: Customer: ACME; Channel: web; Priority: P2");
    expect(brief).toContain("Target: delivered within 1 d of creation.");
    expect(brief).toContain("1. Triage (checkpoint required)");
    expect(brief).toContain("   - [triage.1] Customer, channel and priority are recorded");
    expect(brief).toContain("3. Confirm\n");
    expect(brief).toContain("Review: A person reviews and accepts the delivery.");
    expect(brief).toContain("task_checkpoint");
  });
});
