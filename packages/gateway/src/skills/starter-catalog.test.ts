// T0 (ADR-0015 amendment 1 S1-S5): the complete release pack has a manifest entry for every
// directory, exact hashes, first-party license/provenance, valid Agent Skill files and no scanner
// findings or runtime installer instructions. Mutating bytes without the manifest fails closed.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  STARTER_SKILL_PACK,
  STARTER_SKILL_ROOT,
  loadStarterSkillPack,
  starterSkillCatalog,
} from "./starter-catalog.js";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("release-bundled Starter Skills", () => {
  it("loads a complete, hashed and release-scanned manifest", () => {
    expect(STARTER_SKILL_PACK.version).toBe("1.0.0");
    expect(STARTER_SKILL_PACK.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(STARTER_SKILL_PACK.skills.map((skill) => skill.name)).toEqual([
      "web-research-citations",
      "report-writing",
      "sql-analysis",
      "screenshot-evidence",
      "confirmation-aware-forms",
      "deskmates-collaboration",
      "skill-creator",
    ]);
    expect(new Set(STARTER_SKILL_PACK.skills.map((skill) => skill.category))).toEqual(
      new Set(["research", "data", "browser", "collaboration", "meta"]),
    );
    for (const skill of starterSkillCatalog()) {
      expect(skill).toMatchObject({ origin: "Deskmates", license: "GPL-3.0", version: 1 });
      expect(skill.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("contains no runtime package installation or embedded account material", () => {
    const text = STARTER_SKILL_PACK.skills
      .flatMap((skill) => skill.files.map((file) => file.content))
      .join("\n");
    expect(text).not.toMatch(
      /\b(?:npx|npm\s+(?:i|install)|pip\s+install|apt-get|brew\s+install)\b/i,
    );
    expect(text).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}/);
  });

  it("requires the manifest hash to change with any Skill byte", () => {
    const root = mkdtempSync(join(tmpdir(), "deskmates-starter-skills-"));
    temporary.push(root);
    cpSync(STARTER_SKILL_ROOT, root, { recursive: true });
    const path = join(root, "report-writing", "SKILL.md");
    writeFileSync(path, `${readFileSync(path, "utf8")}\nChanged.\n`);
    expect(() => loadStarterSkillPack(root)).toThrow(/report-writing hash mismatch/);
  });
});
