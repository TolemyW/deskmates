// The rules of ADR-0015 over the skill store: a run's exact skill set (decision 1), provisional
// skills that spread only by evidence or by a human (decision 3), install by content hash
// (decision 4), the scan before any run sees a version (decision 5), measured use and disuse
// (decision 6), immutable versions with undo and replay (decision 7). Authoring from
// consolidation (decision 2) is `authoring.ts`. The Gateway never calls a model here.

import {
  type BotId,
  DeskmatesError,
  type RecordedSkillRef,
  type RunEvent,
  type RunId,
  type RunSkill,
  SKILL_ARCHIVE_DAYS,
  SKILL_STAGES,
  SKILL_STALE_DAYS,
  type Skill,
  type SkillFile,
  type SkillFinding,
  type SkillPromotionEvidence,
  type SkillStage,
  type SkillVersion,
  type WorkspaceId,
  parseSkillFrontmatter,
  recordedSkillSet,
  skillFilesProblem,
} from "@deskmates/contracts";
import type { GatewayDb } from "../db/open.js";
import { skillContentHash } from "./hash.js";
import { scanSkill } from "./scanner.js";
import { SkillStore } from "./skill-store.js";
import { STARTER_SKILL_PACK, isStarterSkillName, rebuildStarterSkills } from "./starter-catalog.js";

const DAY_MS = 86_400_000;

export interface SkillServiceDeps {
  db: GatewayDb;
  /** The workspace's egress allowlist, which the scan checks links against. */
  allowlistOf: (workspaceId: WorkspaceId) => readonly string[];
  /** The workspace a bot belongs to, or undefined when there is no such bot. */
  botWorkspace: (botId: BotId) => WorkspaceId | undefined;
  /** A run's bot and recorded configuration, for measured use. */
  runOf: (runId: RunId) => { botId: BotId; config: Record<string, unknown> } | undefined;
  clock?: () => Date;
}

export interface InstallSkillInput {
  files: readonly SkillFile[];
  /** The hash the human reviewed; the install is refused when the content does not match it. */
  sha256: string;
  provenance?: string;
  /** Bots the installed skill is enabled for; installed skills are human-assigned (decision 4). */
  botIds?: readonly BotId[];
}

export interface SweepChange {
  skillId: string;
  from: SkillStage;
  to: SkillStage;
}

/** Whether `by` names a human (`decidedByHuman`), the only actor that may change a stage. */
export function isHumanActor(by: string): boolean {
  return by.startsWith("human:");
}

function requireHuman(by: string, what: string): void {
  if (!isHumanActor(by)) throw new DeskmatesError("forbidden", `${what} is a human action`);
}

/** Decision 3: a paired comparison passes the strategy decision rule and judges the skill better. */
export function meetsDecisionRule(evidence: SkillPromotionEvidence): boolean {
  return (
    evidence.compare.passes === true &&
    evidence.compare.verdict === "better" &&
    evidence.compare.pairedTasks > 0 &&
    evidence.botIds.length > 0
  );
}

export class SkillService {
  readonly store: SkillStore;

  constructor(private readonly deps: SkillServiceDeps) {
    this.store = new SkillStore(deps.db);
  }

  private now(): Date {
    return this.deps.clock?.() ?? new Date();
  }

  /** Decision 5: the deterministic scan against this workspace's allowlist. */
  scan(workspaceId: WorkspaceId, files: readonly SkillFile[]): SkillFinding[] {
    return scanSkill(files, this.deps.allowlistOf(workspaceId));
  }

  list(workspaceId: WorkspaceId, now: Date = this.now()): Skill[] {
    this.sweep(now);
    return this.store.list(workspaceId);
  }

  /** One page of the workspace's skills (#113), after the same stage sweep as `list`. */
  page(
    workspaceId: WorkspaceId,
    q: string,
    offset: number,
    limit: number,
    now: Date = this.now(),
  ): { items: Skill[]; total: number } {
    this.sweep(now);
    return this.store.page(workspaceId, q, offset, limit);
  }

  mustGetIn(workspaceId: WorkspaceId, id: string): Skill {
    const skill = this.store.mustGet(id);
    if (skill.workspaceId !== workspaceId)
      throw new DeskmatesError("not_found", "Skill not found", { skillId: id });
    return skill;
  }

  private requireBotsIn(workspaceId: WorkspaceId, botIds: readonly BotId[]): void {
    for (const botId of botIds) {
      if (this.deps.botWorkspace(botId) !== workspaceId)
        throw new DeskmatesError(
          "validation",
          "A skill is assigned only to bots of its workspace",
          {
            botId,
          },
        );
    }
  }

  /** Decision 1: exactly the cleared current versions enabled for this bot, by name. */
  skillSetFor(workspaceId: WorkspaceId, botId: BotId, now: Date = this.now()): RunSkill[] {
    this.sweep(now);
    const workspaceSkills = this.store.enabledFor(workspaceId, botId).flatMap((skill) => {
      const version = this.store.version(skill.id, skill.version);
      return version
        ? [
            {
              skillId: skill.id,
              name: skill.name,
              version: version.version,
              sha256: version.sha256,
              files: version.files,
            },
          ]
        : [];
    });
    // A release may introduce a built-in whose name existed as a workspace Skill. The audited
    // built-in wins deterministically; new installs/authored versions are refused or held above.
    return [
      ...STARTER_SKILL_PACK.skills,
      ...workspaceSkills.filter((skill) => !isStarterSkillName(skill.name)),
    ];
  }

  /**
   * Decision 7: the skill set a recorded run was given, rebuilt from its refs. Undefined when a
   * version is missing or its content no longer has the recorded hash: replay says so rather
   * than substituting another set.
   */
  rebuildSet(workspaceId: WorkspaceId, refs: readonly RecordedSkillRef[]): RunSkill[] | undefined {
    const starter = rebuildStarterSkills(refs);
    if (!starter) return undefined;
    const starters = new Map(starter.map((skill) => [skill.skillId, skill]));
    const out: RunSkill[] = [];
    for (const ref of refs) {
      const builtIn = starters.get(ref.skillId);
      if (builtIn) {
        out.push(builtIn);
        continue;
      }
      const skill = this.store.get(ref.skillId);
      const version = skill ? this.store.version(ref.skillId, ref.version) : undefined;
      if (!skill || skill.workspaceId !== workspaceId || !version) return undefined;
      if (skillContentHash(version.files) !== ref.sha256) return undefined;
      out.push({ ...ref, files: version.files });
    }
    return out;
  }

  /** Decision 4: install a third-party skill pinned to the hash the human reviewed. */
  install(
    workspaceId: WorkspaceId,
    input: InstallSkillInput,
    by: string,
  ): { skill: Skill; version: SkillVersion } {
    requireHuman(by, "Installing a skill");
    const skillMd = input.files.find((f) => f.path === "SKILL.md");
    const front = skillMd ? parseSkillFrontmatter(skillMd.content) : undefined;
    const name = front?.name ?? "";
    const problem = skillFilesProblem(name, input.files);
    if (problem) throw new DeskmatesError("validation", problem);
    if (isStarterSkillName(name))
      throw new DeskmatesError("validation", "A release-bundled Starter Skill reserves this name", {
        name,
      });
    const sha256 = skillContentHash(input.files);
    if (sha256 !== input.sha256)
      throw new DeskmatesError("validation", "The skill content does not match the pinned hash", {
        expected: input.sha256,
        actual: sha256,
      });
    const botIds = input.botIds ?? [];
    this.requireBotsIn(workspaceId, botIds);
    const at = this.now().toISOString();
    return this.deps.db.transaction(() => {
      const existing = this.store.byName(workspaceId, name);
      if (existing && existing.origin !== "installed")
        throw new DeskmatesError(
          "validation",
          "A skill a bot authored already has this name; install under another name",
          { skillId: existing.id },
        );
      // The same content again is the same install: no new version, nothing re-scanned.
      if (existing && existing.sha256 === sha256) {
        for (const botId of botIds) this.store.assign(existing.id, botId, "human", by, at);
        const current = this.store.version(existing.id, existing.version);
        if (!current) throw new DeskmatesError("not_found", "Skill version not found");
        return { skill: this.store.mustGet(existing.id), version: current };
      }
      const findings = this.scan(workspaceId, input.files);
      const skillId =
        existing?.id ??
        this.store.insert({
          workspaceId,
          name,
          origin: "installed",
          stage: "active",
          ...(input.provenance ? { provenance: input.provenance } : {}),
          at,
        });
      const version = this.store.addVersion(skillId, {
        op: "install",
        files: input.files,
        sha256,
        description: front?.description ?? "",
        review: findings.length > 0 ? "pending" : "cleared",
        holdReasons: findings.length > 0 ? ["scan_findings"] : [],
        findings,
        by,
        at,
      });
      if (findings.length === 0) this.store.setCurrent(skillId, version, at);
      for (const botId of botIds) this.store.assign(skillId, botId, "human", by, at);
      const stored = this.store.version(skillId, version);
      if (!stored) throw new DeskmatesError("not_found", "Skill version not found");
      return { skill: this.store.mustGet(skillId), version: stored };
    })();
  }

  private pendingVersion(skill: Skill, version: number): SkillVersion {
    const found = this.store.version(skill.id, version);
    if (!found) throw new DeskmatesError("not_found", "Skill version not found");
    if (found.review !== "pending")
      throw new DeskmatesError("invalid_transition", "This version is not waiting for a decision", {
        review: found.review,
      });
    return found;
  }

  /** "Needs your confirmation", answered yes: the version becomes current if it is the newest. */
  confirm(workspaceId: WorkspaceId, skillId: string, version: number, by: string): Skill {
    requireHuman(by, "Confirming a skill");
    const skill = this.mustGetIn(workspaceId, skillId);
    this.pendingVersion(skill, version);
    const at = this.now().toISOString();
    this.deps.db.transaction(() => {
      this.store.setReview(skill.id, version, "cleared", by, at);
      if (version > skill.version) this.store.setCurrent(skill.id, version, at);
    })();
    return this.store.mustGet(skill.id);
  }

  reject(workspaceId: WorkspaceId, skillId: string, version: number, by: string): Skill {
    requireHuman(by, "Rejecting a skill");
    const skill = this.mustGetIn(workspaceId, skillId);
    this.pendingVersion(skill, version);
    this.store.setReview(skill.id, version, "rejected", by, this.now().toISOString());
    return this.store.mustGet(skill.id);
  }

  /** Decision 3, the human way: the skill is active for exactly these bots (and its author). */
  assign(workspaceId: WorkspaceId, skillId: string, botIds: readonly BotId[], by: string): Skill {
    requireHuman(by, "Assigning a skill");
    const skill = this.mustGetIn(workspaceId, skillId);
    this.requireBotsIn(workspaceId, botIds);
    const at = this.now().toISOString();
    this.deps.db.transaction(() => {
      this.store.unassignAllExcept(skill.id, botIds);
      for (const botId of botIds) this.store.assign(skill.id, botId, "human", by, at);
      if (skill.stage !== "active") this.store.setStage(skill.id, "active", at, true);
    })();
    return this.store.mustGet(skill.id);
  }

  /**
   * Decision 3: a provisional skill becomes active for other bots only with a paired comparison
   * that meets the decision rule, or by a human. Anything else is refused.
   */
  promote(
    workspaceId: WorkspaceId,
    skillId: string,
    input: { by: string; evidence?: SkillPromotionEvidence },
  ): Skill {
    const skill = this.mustGetIn(workspaceId, skillId);
    if (skill.version === 0)
      throw new DeskmatesError("invalid_transition", "No cleared version to promote");
    const at = this.now().toISOString();
    const { evidence } = input;
    if (evidence) {
      if (evidence.sha256 !== skill.sha256)
        throw new DeskmatesError(
          "invalid_transition",
          "The comparison was run with another version of this skill",
        );
      if (!meetsDecisionRule(evidence))
        throw new DeskmatesError(
          "invalid_transition",
          "The paired comparison does not meet the strategy decision rule",
          { compare: evidence.compare },
        );
      this.requireBotsIn(workspaceId, evidence.botIds);
      this.deps.db.transaction(() => {
        for (const botId of evidence.botIds)
          this.store.assign(skill.id, botId, "evidence", input.by, at, evidence);
        if (skill.stage !== "active") this.store.setStage(skill.id, "active", at, true);
      })();
      return this.store.mustGet(skill.id);
    }
    if (!isHumanActor(input.by))
      throw new DeskmatesError(
        "invalid_transition",
        "Promotion needs a paired comparison that meets the decision rule, or a human",
      );
    if (skill.stage !== "active") this.store.setStage(skill.id, "active", at, true);
    return this.store.mustGet(skill.id);
  }

  /** Decision 7: a human can move a skill to any stage. */
  setStage(workspaceId: WorkspaceId, skillId: string, stage: SkillStage, by: string): Skill {
    requireHuman(by, "Moving a skill");
    if (!(SKILL_STAGES as readonly string[]).includes(stage))
      throw new DeskmatesError("validation", "Unknown skill stage");
    const skill = this.mustGetIn(workspaceId, skillId);
    const relisted = stage === "provisional" || stage === "active";
    this.store.setStage(skill.id, stage, this.now().toISOString(), relisted);
    return this.store.mustGet(skill.id);
  }

  /** Decision 6: a pinned skill is never moved by disuse. */
  setPinned(workspaceId: WorkspaceId, skillId: string, pinned: boolean, by: string): Skill {
    requireHuman(by, "Pinning a skill");
    const skill = this.mustGetIn(workspaceId, skillId);
    this.store.setPinned(skill.id, pinned, this.now().toISOString());
    return this.store.mustGet(skill.id);
  }

  /** Decision 7: a new version whose content is the previous cleared version, byte for byte. */
  undo(workspaceId: WorkspaceId, skillId: string, by: string): Skill {
    requireHuman(by, "Undoing a skill version");
    const skill = this.mustGetIn(workspaceId, skillId);
    const previous = this.store
      .versions(skill.id)
      .filter((v) => v.version < skill.version && v.review === "cleared")
      .at(-1);
    if (!previous) throw new DeskmatesError("invalid_transition", "No earlier version to restore");
    const at = this.now().toISOString();
    this.deps.db.transaction(() => {
      const version = this.store.addVersion(skill.id, {
        op: "undo",
        files: previous.files,
        sha256: previous.sha256,
        description: previous.description,
        review: "cleared",
        findings: previous.findings,
        derivedFrom: [`${skill.id}@${previous.version}`],
        by,
        at,
      });
      this.store.setReview(skill.id, version, "cleared", by, at);
      this.store.setCurrent(skill.id, version, at);
    })();
    return this.store.mustGet(skill.id);
  }

  /**
   * Decision 6: use is what the sidecar hook recorded. Only a sidecar-originated `skill_used`
   * event counts, and only for a skill in the run's recorded skill set.
   */
  recordUse(event: RunEvent): void {
    if (event.kind !== "skill_used" || event.sidecarSeq === undefined) return;
    const name = typeof event.payload.skill === "string" ? event.payload.skill : "";
    const run = this.deps.runOf(event.runId);
    if (!run || name === "") return;
    const ref = recordedSkillSet(run.config)?.set.find((r) => r.name === name);
    if (!ref || !this.store.get(ref.skillId)) return;
    this.store.recordUse(ref.skillId, run.botId, event.ts);
  }

  /** Decision 6: 14 days without use makes a skill stale, 30 archived. Pinned skills stay. */
  sweep(now: Date = this.now()): SweepChange[] {
    const changes: SweepChange[] = [];
    const at = now.toISOString();
    for (const row of this.store.sweepable()) {
      const idleDays = (now.getTime() - Date.parse(row.idleSince)) / DAY_MS;
      const to: SkillStage | undefined =
        idleDays >= SKILL_ARCHIVE_DAYS
          ? "archived"
          : idleDays >= SKILL_STALE_DAYS && row.stage !== "stale"
            ? "stale"
            : undefined;
      if (!to || to === row.stage) continue;
      this.store.setStage(row.id, to, at, false);
      changes.push({ skillId: row.id, from: row.stage, to });
    }
    return changes;
  }
}
