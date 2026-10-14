import { describe, expect, it } from "vitest";
import { applySoulEdits, diffSoulLines } from "./soul-proposal.js";

const BASE = [
  "# Role",
  "You review pull requests.",
  "",
  "## Voice",
  "Terse,  *custom*  formatting kept.",
  "",
  "## Human notes",
  "Never merge on Fridays.",
  "",
].join("\n");

describe("applySoulEdits", () => {
  it("changes only the requested span and keeps every other byte", () => {
    const result = applySoulEdits(BASE, [
      { find: "You review pull requests.", replace: "You review pull requests and release notes." },
    ]);
    expect(result).toEqual({
      ok: true,
      body: BASE.replace(
        "You review pull requests.",
        "You review pull requests and release notes.",
      ),
    });
    if (!result.ok) throw new Error("unreachable");
    expect(result.body).toContain("Terse,  *custom*  formatting kept.");
    expect(result.body).toContain("Never merge on Fridays.");
  });

  it("appends a new section after the existing text", () => {
    const result = applySoulEdits(BASE, [], "## Escalation\nAsk a human before deploying.");
    expect(result.ok && result.body).toBe(
      `${BASE.trimEnd()}\n\n## Escalation\nAsk a human before deploying.\n`,
    );
  });

  it("creates from an empty base with append alone", () => {
    expect(applySoulEdits("", [], "# Role\nHelp.")).toEqual({ ok: true, body: "# Role\nHelp.\n" });
  });

  it("refuses an unmatched, ambiguous, overlapping or empty edit set", () => {
    expect(applySoulEdits(BASE, [{ find: "absent", replace: "x" }])).toMatchObject({
      ok: false,
      error: "not_found",
    });
    expect(applySoulEdits(BASE, [{ find: "##", replace: "x" }])).toMatchObject({
      ok: false,
      error: "ambiguous",
    });
    expect(
      applySoulEdits(BASE, [
        { find: "You review", replace: "x" },
        { find: "review pull", replace: "y" },
      ]),
    ).toMatchObject({ ok: false, error: "overlap" });
    expect(applySoulEdits(BASE, [])).toMatchObject({ ok: false, error: "no_edits" });
  });
});

describe("diffSoulLines", () => {
  it("marks the changed line only", () => {
    const after = BASE.replace("Never merge on Fridays.", "Never merge on weekends.");
    const diff = diffSoulLines(BASE, after).filter((line) => line.kind !== "same");
    expect(diff).toEqual([
      { kind: "removed", text: "Never merge on Fridays." },
      { kind: "added", text: "Never merge on weekends." },
    ]);
  });

  it("is all additions from an empty SOUL", () => {
    expect(diffSoulLines("", "a\nb")).toEqual([
      { kind: "added", text: "a" },
      { kind: "added", text: "b" },
    ]);
  });
});
