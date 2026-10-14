// T0: the pure skill helpers (ADR-0015). A skill directory is refused before it is stored when
// its name or paths are unsafe or its SKILL.md does not name it; the content hash input does not
// depend on file order; a recorded skill set is read back only when well formed.

import { describe, expect, it } from "vitest";
import {
  isSkillFilePath,
  parseSkillFrontmatter,
  pluginSkillName,
  recordedSkillSet,
  skillFilesProblem,
  skillHashInput,
  skillMarkdown,
} from "./skill.js";

const md = skillMarkdown({ name: "export-refunds", description: "Export refunds.", body: "Go." });

describe("skill helpers", () => {
  it("writes and reads SKILL.md frontmatter", () => {
    expect(parseSkillFrontmatter(md)).toEqual({
      name: "export-refunds",
      description: "Export refunds.",
    });
    expect(parseSkillFrontmatter("no frontmatter")).toBeUndefined();
  });

  it("accepts safe relative paths only", () => {
    expect(isSkillFilePath("SKILL.md")).toBe(true);
    expect(isSkillFilePath("reference/columns.md")).toBe(true);
    for (const bad of ["../x", "/etc/passwd", "a/../../b", "", ".hidden", "a//b", "a/b/c/d/e"])
      expect(isSkillFilePath(bad), bad).toBe(false);
  });

  it("refuses unsafe names, missing or mismatched SKILL.md and duplicates", () => {
    const ok = [{ path: "SKILL.md", content: md }];
    expect(skillFilesProblem("export-refunds", ok)).toBeUndefined();
    expect(skillFilesProblem("Export Refunds", ok)).toMatch(/kebab/);
    expect(skillFilesProblem("other-name", ok)).toMatch(/does not match/);
    expect(skillFilesProblem("export-refunds", [{ path: "README.md", content: md }])).toMatch(
      /SKILL\.md/,
    );
    expect(skillFilesProblem("export-refunds", [...ok, ...ok])).toMatch(/duplicate/);
    expect(
      skillFilesProblem("export-refunds", [...ok, { path: "../escape.sh", content: "" }]),
    ).toMatch(/unsafe/);
  });

  it("hashes the same files the same in any order", () => {
    const a = { path: "SKILL.md", content: md };
    const b = { path: "notes.md", content: "x" };
    expect(skillHashInput([a, b])).toBe(skillHashInput([b, a]));
    expect(skillHashInput([a])).not.toBe(skillHashInput([a, b]));
  });

  it("qualifies names with the run plugin and reads back only a well-formed set", () => {
    expect(pluginSkillName("export-refunds")).toBe("deskmates-skills:export-refunds");
    const set = [{ skillId: "skill_1", name: "x", version: 1, sha256: "ab" }];
    expect(recordedSkillSet({ skills: { version: 1, set } })).toEqual({ version: 1, set });
    expect(
      recordedSkillSet({
        skills: { version: 1, set, starterPack: { version: "1.0.0", sha256: "cd" } },
      }),
    ).toEqual({ version: 1, set, starterPack: { version: "1.0.0", sha256: "cd" } });
    expect(
      recordedSkillSet({ skills: { version: 1, set, starterPack: { version: 1, sha256: "cd" } } }),
    ).toBeUndefined();
    expect(recordedSkillSet({ skills: { version: 2, set } })).toBeUndefined();
    expect(recordedSkillSet({ skills: { version: 1, set: [{ name: 1 }] } })).toBeUndefined();
    expect(recordedSkillSet({})).toBeUndefined();
  });
});
