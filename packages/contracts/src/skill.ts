// Skills (ADR-0015): directories in the Agent Skills format that the Gateway holds per workspace
// and hands to each run as an exact, recorded skill set. Bots author them only in consolidation;
// humans install them by content hash. Every skill is scanned before any run sees it.

import type { BotId, IsoTimestamp, RunId, WorkspaceId } from "./ids.js";

/** `installed`: a human added it. `authored`: a consolidation run wrote it. */
export const SKILL_ORIGINS = ["installed", "authored"] as const;
export type SkillOrigin = (typeof SKILL_ORIGINS)[number];

/**
 * `provisional`: enabled for its author bot only. `active`: enabled for the bots it is assigned
 * to. `stale` and `archived`: not listed, kept, restorable. Nothing is deleted (definitions).
 */
export const SKILL_STAGES = ["provisional", "active", "stale", "archived"] as const;
export type SkillStage = (typeof SKILL_STAGES)[number];

/** A version's review state: held for a human, cleared for runs, or turned down. */
export type SkillReview = "pending" | "cleared" | "rejected";

/** How a version came to be (decision 7: every write is an immutable version). */
export type SkillVersionOp = "author" | "revise" | "install" | "undo";

/** One file of a skill directory; `SKILL.md` is always present. Paths are relative. */
export interface SkillFile {
  path: string;
  content: string;
}

/** What the deterministic scan reports (decision 5). */
export type SkillFindingKind =
  | "off_allowlist_url"
  | "credential"
  | "rule_instruction"
  | "executable_file";

export interface SkillFinding {
  kind: SkillFindingKind;
  path: string;
  /** 1-based line of the finding; absent for a whole-file finding. */
  line?: number;
  /** What was found, never the matched secret itself. */
  detail: string;
}

/**
 * Why a version waits in "needs your confirmation". The episode reasons are decision 2's
 * authoring conditions; `scan_findings` is decision 5; the revision reasons keep decision 4
 * (installed skills are pinned by hash) and decision 2 (a bot revises only skills it used).
 */
export type SkillHoldReason =
  | "scan_findings"
  | "no_closed_episode"
  | "untrusted_source"
  | "episode_not_succeeded"
  | "too_few_tool_calls"
  | "duty_change"
  | "do_not_learn"
  | "starter_name_reserved"
  | "revises_installed_skill"
  | "revises_unused_skill";

/** How a bot came to have an active skill: a human assigned it, or a paired comparison did. */
export type SkillAssignmentBasis = "human" | "evidence";

export interface SkillAssignment {
  botId: BotId;
  basis: SkillAssignmentBasis;
  by: string;
  createdAt: IsoTimestamp;
}

export interface Skill {
  id: string;
  workspaceId: WorkspaceId;
  name: string;
  /** From the current version's `SKILL.md`; empty while no version is cleared. */
  description: string;
  origin: SkillOrigin;
  stage: SkillStage;
  /** The bot whose consolidation wrote the first version; absent for installed skills. */
  authorBotId?: BotId;
  assignments: SkillAssignment[];
  /** The version runs receive; 0 while no version has been cleared. */
  version: number;
  /** SHA-256 of the current version's content; absent while `version` is 0. */
  sha256?: string;
  /** A pinned skill is never moved to `stale` or `archived` by disuse (decision 6). */
  pinned: boolean;
  /** Where a copied or installed skill came from, as the human who added it said. */
  provenance?: string;
  /** Last `skill_used` event the sidecar hook recorded for it, by any bot of the workspace. */
  lastUsedAt?: IsoTimestamp;
  /** When it last became listed (provisional or active) or got a new current version. */
  listedSince: IsoTimestamp;
  /** Versions waiting in "needs your confirmation". */
  pendingVersions: number;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface SkillVersion {
  skillId: string;
  version: number;
  op: SkillVersionOp;
  files: SkillFile[];
  sha256: string;
  description: string;
  review: SkillReview;
  holdReasons: SkillHoldReason[];
  findings: SkillFinding[];
  sourceRunId?: RunId;
  /** Memory entries (episodes, candidates) a consolidation derived it from. */
  derivedFrom: string[];
  by: string;
  createdAt: IsoTimestamp;
  decidedBy?: string;
  decidedAt?: IsoTimestamp;
}

/** What `runs.config_json.skills.set` records per skill (decision 1, decision 7). */
export interface RecordedSkillRef {
  skillId: string;
  name: string;
  version: number;
  sha256: string;
}

/** One skill of a run's skill set, as the sidecar writes it into the run's local plugin. */
export interface RunSkill extends RecordedSkillRef {
  files: SkillFile[];
}

/** One release-bundled Starter Skill (ADR-0015 amendment 1). It is not a database Skill row. */
export interface StarterSkill {
  /** Stable run/reference id. Starter Skills reserve the `starter:` prefix. */
  id: string;
  name: string;
  description: string;
  category: string;
  origin: string;
  license: string;
  version: number;
  sha256: string;
}

/** Exact built-in pack that contributed Starter Skills to a run. */
export interface RecordedStarterSkillPack {
  version: string;
  sha256: string;
}

/** `runs.config_json.skills`: the exact set enabled for the run. */
export interface RecordedSkillSet {
  version: 1;
  set: RecordedSkillRef[];
  starterPack?: RecordedStarterSkillPack;
}

/**
 * A skill a consolidation run reports in its summary (decision 2). The model writes the content;
 * the Gateway decides, from its own records, whether it is stored as cleared or held.
 */
export interface ProposedSkill {
  name: string;
  description: string;
  /** The instructions below the frontmatter of `SKILL.md`. */
  body: string;
}

/** The decision-rule verdicts of `evals/compare.ts` (measurement §4.3). */
export type CompareVerdict = "better" | "worse" | "no difference" | "inconclusive";

/**
 * A paired `evals/compare.ts` result of the named bots with and without the skill at `sha256`
 * (decision 3). The Gateway never runs an evaluation; it checks the result against the rule.
 */
export interface SkillPromotionEvidence {
  sha256: string;
  botIds: BotId[];
  compare: { passes: boolean; verdict: CompareVerdict; pairedTasks: number };
}

/** A skill is stale after 14 days without use and archived after 30 (decision 6). */
export const SKILL_STALE_DAYS = 14;
export const SKILL_ARCHIVE_DAYS = 30;

/** Decision 2: the closed episode a skill is derived from used at least this many tool calls. */
export const SKILL_AUTHORING_MIN_TOOL_CALLS = 10;

/** The local plugin the sidecar writes each run's skill set into (decision 1). */
export const SKILL_PLUGIN_NAME = "deskmates-skills";

export const SKILL_MAX_FILES = 32;
export const SKILL_MAX_BYTES = 256 * 1024;

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PATH_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;

/** A skill name is also its directory name: lower-case kebab, at most 64 characters. */
export function isSkillName(name: string): boolean {
  return SKILL_NAME.test(name);
}

/** A relative path inside a skill directory: no `..`, no absolute path, at most four levels. */
export function isSkillFilePath(path: string): boolean {
  const segments = path.split("/");
  return segments.length <= 4 && segments.every((s) => PATH_SEGMENT.test(s));
}

/** `name` and `description` from the YAML-style frontmatter of a `SKILL.md`, when present. */
export function parseSkillFrontmatter(
  content: string,
): { name: string; description: string } | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match?.[1]) return undefined;
  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv?.[1] && kv[2] !== undefined)
      fields.set(kv[1], kv[2].trim().replace(/^(["'])(.*)\1$/, "$2"));
  }
  const name = fields.get("name");
  const description = fields.get("description");
  return name && description ? { name, description } : undefined;
}

/** The `SKILL.md` of a proposed skill: frontmatter the SDK reads, then the instructions. */
export function skillMarkdown(skill: ProposedSkill): string {
  const description = skill.description.replace(/\s+/g, " ").trim();
  return `---\nname: ${skill.name}\ndescription: ${description}\n---\n\n${skill.body.trim()}\n`;
}

/**
 * The checks every skill directory passes before it is stored, whoever wrote it: a valid name,
 * safe relative paths, a `SKILL.md` whose frontmatter names the same skill, size caps. Returns
 * the problem, or undefined. The content scan (decision 5) is separate: findings hold a skill,
 * these problems refuse it.
 */
export function skillFilesProblem(name: string, files: readonly SkillFile[]): string | undefined {
  if (!isSkillName(name)) return "skill name must be lower-case kebab-case, at most 64 characters";
  if (files.length === 0 || files.length > SKILL_MAX_FILES)
    return `a skill has 1 to ${SKILL_MAX_FILES} files`;
  const seen = new Set<string>();
  let bytes = 0;
  for (const file of files) {
    if (typeof file.path !== "string" || typeof file.content !== "string")
      return "every file needs a path and text content";
    if (!isSkillFilePath(file.path)) return `unsafe file path: ${file.path}`;
    if (seen.has(file.path)) return `duplicate file path: ${file.path}`;
    seen.add(file.path);
    bytes += file.content.length;
  }
  if (bytes > SKILL_MAX_BYTES) return `a skill is at most ${SKILL_MAX_BYTES} characters`;
  const skillMd = files.find((f) => f.path === "SKILL.md");
  if (!skillMd) return "a skill needs a SKILL.md";
  const front = parseSkillFrontmatter(skillMd.content);
  if (!front) return "SKILL.md needs frontmatter with name and description";
  if (front.name !== name) return "SKILL.md name does not match the skill name";
  return undefined;
}

/** Files in path order, so a hash and a byte comparison never depend on input order. */
export function sortSkillFiles(files: readonly SkillFile[]): SkillFile[] {
  return [...files]
    .map((f) => ({ path: f.path, content: f.content }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The text a skill's SHA-256 is computed over: canonical JSON of its sorted files. */
export function skillHashInput(files: readonly SkillFile[]): string {
  return JSON.stringify(sortSkillFiles(files).map((f) => [f.path, f.content]));
}

/** The name the SDK's `skills` option uses for a skill of the run's plugin. */
export function pluginSkillName(name: string): string {
  return `${SKILL_PLUGIN_NAME}:${name}`;
}

/** `runs.config_json.skills`, when the run recorded one. */
export function recordedSkillSet(config: Record<string, unknown>): RecordedSkillSet | undefined {
  const raw = config.skills as Partial<RecordedSkillSet> | undefined;
  if (!raw || raw.version !== 1 || !Array.isArray(raw.set)) return undefined;
  const ok = raw.set.every(
    (ref) =>
      ref &&
      typeof ref.skillId === "string" &&
      typeof ref.name === "string" &&
      typeof ref.sha256 === "string" &&
      Number.isSafeInteger(ref.version),
  );
  const pack = raw.starterPack;
  const packOk =
    pack === undefined ||
    (typeof pack === "object" &&
      pack !== null &&
      typeof pack.version === "string" &&
      typeof pack.sha256 === "string");
  return ok && packOk ? (raw as RecordedSkillSet) : undefined;
}
