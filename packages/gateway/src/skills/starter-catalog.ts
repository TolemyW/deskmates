// Release-bundled Starter Skills (ADR-0015 amendment 1). The checked-in manifest and directories
// are the release asset; loading validates every byte, frontmatter and scanner finding before a
// run can see it. They are not copied into workspace Skill rows or assigned per Bot.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type RecordedSkillRef,
  type RunSkill,
  type SkillFile,
  type StarterSkill,
  parseSkillFrontmatter,
  skillFilesProblem,
} from "@deskmates/contracts";
import { skillContentHash } from "./hash.js";
import { scanSkill } from "./scanner.js";

const STARTER_ID_PREFIX = "starter:";
const SHA256 = /^[a-f0-9]{64}$/;
const CATEGORY = /^[a-z][a-z0-9-]{0,31}$/;

interface ManifestEntry {
  name: string;
  category: string;
  origin: string;
  license: string;
  version: number;
  sha256: string;
}

interface StarterManifest {
  schemaVersion: 1;
  packVersion: string;
  skills: ManifestEntry[];
}

export interface StarterRunSkill extends RunSkill {
  description: string;
  category: string;
  origin: string;
  license: string;
}

export interface StarterSkillPack {
  version: string;
  sha256: string;
  skills: readonly StarterRunSkill[];
}

export const STARTER_SKILL_ROOT = fileURLToPath(new URL("../../starter-skills/", import.meta.url));

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function manifestEntry(value: unknown, index: number): ManifestEntry {
  const row = record(value, `Starter Skill manifest entry ${index} must be an object`);
  const { name, category, origin, license, version, sha256 } = row;
  if (
    typeof name !== "string" ||
    typeof category !== "string" ||
    typeof origin !== "string" ||
    typeof license !== "string" ||
    !Number.isSafeInteger(version) ||
    (version as number) < 1 ||
    typeof sha256 !== "string"
  )
    throw new Error(`Starter Skill manifest entry ${index} has invalid fields`);
  if (!CATEGORY.test(category)) throw new Error(`Starter Skill ${name} has an invalid category`);
  if (origin.trim() === "" || license.trim() === "")
    throw new Error(`Starter Skill ${name} needs origin and license`);
  if (!SHA256.test(sha256)) throw new Error(`Starter Skill ${name} has an invalid sha256`);
  return { name, category, origin, license, version: version as number, sha256 };
}

function parseManifest(text: string): StarterManifest {
  const raw = record(JSON.parse(text) as unknown, "Starter Skill manifest must be an object");
  if (raw.schemaVersion !== 1 || typeof raw.packVersion !== "string" || raw.packVersion === "")
    throw new Error("Starter Skill manifest has an unsupported schema or empty pack version");
  if (!Array.isArray(raw.skills) || raw.skills.length === 0)
    throw new Error("Starter Skill manifest must list at least one skill");
  return {
    schemaVersion: 1,
    packVersion: raw.packVersion,
    skills: raw.skills.map(manifestEntry),
  };
}

function filesIn(root: string, name: string): SkillFile[] {
  const dir = join(root, name);
  const entries = readdirSync(dir, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile()))
    throw new Error(`Starter Skill ${name} may contain regular files only`);
  return entries
    .map((entry) => ({ path: entry.name, content: readFileSync(join(dir, entry.name), "utf8") }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function packHash(version: string, skills: readonly StarterRunSkill[]): string {
  const refs = skills.map(({ name, version: skillVersion, sha256 }) => ({
    name,
    version: skillVersion,
    sha256,
  }));
  return createHash("sha256")
    .update(JSON.stringify({ version, skills: refs }))
    .digest("hex");
}

/** Load and release-gate the complete checked-in pack. A bad asset fails Gateway startup. */
export function loadStarterSkillPack(root: string = STARTER_SKILL_ROOT): StarterSkillPack {
  const manifest = parseManifest(readFileSync(join(root, "manifest.json"), "utf8"));
  const names = new Set<string>();
  const skills = manifest.skills.map((entry): StarterRunSkill => {
    if (names.has(entry.name)) throw new Error(`Duplicate Starter Skill ${entry.name}`);
    names.add(entry.name);
    const files = filesIn(root, entry.name);
    const problem = skillFilesProblem(entry.name, files);
    if (problem) throw new Error(`Starter Skill ${entry.name}: ${problem}`);
    const frontmatter = parseSkillFrontmatter(
      files.find((file) => file.path === "SKILL.md")?.content ?? "",
    );
    if (!frontmatter) throw new Error(`Starter Skill ${entry.name} has no frontmatter`);
    const actual = skillContentHash(files);
    if (actual !== entry.sha256)
      throw new Error(`Starter Skill ${entry.name} hash mismatch: ${actual}`);
    const findings = scanSkill(files, ["*"]);
    if (findings.length > 0)
      throw new Error(
        `Starter Skill ${entry.name} failed release scan: ${JSON.stringify(findings)}`,
      );
    return {
      skillId: `${STARTER_ID_PREFIX}${entry.name}`,
      name: entry.name,
      description: frontmatter.description,
      category: entry.category,
      origin: entry.origin,
      license: entry.license,
      version: entry.version,
      sha256: entry.sha256,
      files,
    };
  });
  const directories = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (JSON.stringify(directories) !== JSON.stringify([...names].sort()))
    throw new Error("Starter Skill manifest and directories do not match");
  return { version: manifest.packVersion, sha256: packHash(manifest.packVersion, skills), skills };
}

export const STARTER_SKILL_PACK = loadStarterSkillPack();

export function starterSkillCatalog(pack: StarterSkillPack = STARTER_SKILL_PACK): StarterSkill[] {
  return pack.skills.map(({ skillId: id, files: _files, ...skill }) => ({ id, ...skill }));
}

export function starterSkillRefs(pack: StarterSkillPack = STARTER_SKILL_PACK): RecordedSkillRef[] {
  return pack.skills.map(({ skillId, name, version, sha256 }) => ({
    skillId,
    name,
    version,
    sha256,
  }));
}

export function rebuildStarterSkills(
  refs: readonly RecordedSkillRef[],
  pack: StarterSkillPack = STARTER_SKILL_PACK,
): RunSkill[] | undefined {
  const byId = new Map(pack.skills.map((skill) => [skill.skillId, skill]));
  const rebuilt: RunSkill[] = [];
  for (const ref of refs) {
    if (!ref.skillId.startsWith(STARTER_ID_PREFIX)) continue;
    const skill = byId.get(ref.skillId);
    if (
      !skill ||
      skill.name !== ref.name ||
      skill.version !== ref.version ||
      skill.sha256 !== ref.sha256
    )
      return undefined;
    rebuilt.push(skill);
  }
  return rebuilt;
}

export function isStarterSkillName(name: string): boolean {
  return STARTER_SKILL_PACK.skills.some((skill) => skill.name === name);
}
