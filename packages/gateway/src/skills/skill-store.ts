// Skill rows, their immutable versions, assignments and measured use (ADR-0015). Every query is
// keyed by workspace or by a skill id that belongs to one: a skill never leaves its workspace
// (decision 3). Business rules (who may promote, what holds a version) live in `skill-service.ts`.

import {
  type BotId,
  DeskmatesError,
  type RunId,
  type Skill,
  type SkillAssignment,
  type SkillAssignmentBasis,
  type SkillFile,
  type SkillFinding,
  type SkillHoldReason,
  type SkillOrigin,
  type SkillReview,
  type SkillStage,
  type SkillVersion,
  type SkillVersionOp,
  type WorkspaceId,
  sortSkillFiles,
} from "@deskmates/contracts";
import { newId, parseJson } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";

interface SkillRow {
  id: string;
  workspace_id: string;
  name: string;
  origin: SkillOrigin;
  stage: SkillStage;
  author_bot_id: string | null;
  current_version: number;
  pinned: number;
  provenance: string | null;
  listed_since: string;
  created_at: string;
  updated_at: string;
}

interface VersionRow {
  skill_id: string;
  version: number;
  op: SkillVersionOp;
  files_json: string;
  sha256: string;
  description: string;
  review: SkillReview;
  hold_reasons_json: string;
  findings_json: string;
  source_run_id: string | null;
  derived_from_json: string;
  by: string;
  created_at: string;
  decided_by: string | null;
  decided_at: string | null;
}

function toVersion(row: VersionRow): SkillVersion {
  return {
    skillId: row.skill_id,
    version: row.version,
    op: row.op,
    files: parseJson<SkillFile[]>(row.files_json, []),
    sha256: row.sha256,
    description: row.description,
    review: row.review,
    holdReasons: parseJson<SkillHoldReason[]>(row.hold_reasons_json, []),
    findings: parseJson<SkillFinding[]>(row.findings_json, []),
    ...(row.source_run_id ? { sourceRunId: row.source_run_id as RunId } : {}),
    derivedFrom: parseJson<string[]>(row.derived_from_json, []),
    by: row.by,
    createdAt: row.created_at,
    ...(row.decided_by ? { decidedBy: row.decided_by } : {}),
    ...(row.decided_at ? { decidedAt: row.decided_at } : {}),
  };
}

export interface NewSkill {
  workspaceId: WorkspaceId;
  name: string;
  origin: SkillOrigin;
  stage: SkillStage;
  authorBotId?: BotId;
  provenance?: string;
  at: string;
}

export interface NewSkillVersion {
  op: SkillVersionOp;
  files: readonly SkillFile[];
  sha256: string;
  description: string;
  review: SkillReview;
  holdReasons?: readonly SkillHoldReason[];
  findings?: readonly SkillFinding[];
  sourceRunId?: RunId;
  derivedFrom?: readonly string[];
  by: string;
  at: string;
}

export class SkillStore {
  constructor(readonly db: GatewayDb) {}

  private row(id: string): SkillRow | undefined {
    return this.db.prepare("SELECT * FROM skills WHERE id = ?").get(id) as SkillRow | undefined;
  }

  private toSkill(row: SkillRow): Skill {
    const current = row.current_version > 0 ? this.version(row.id, row.current_version) : undefined;
    const used = this.db
      .prepare("SELECT MAX(last_used_at) AS at FROM skill_usage WHERE skill_id = ?")
      .get(row.id) as { at: string | null };
    const { pending } = this.db
      .prepare(
        "SELECT COUNT(*) AS pending FROM skill_versions WHERE skill_id = ? AND review = 'pending'",
      )
      .get(row.id) as { pending: number };
    return {
      id: row.id,
      workspaceId: row.workspace_id as WorkspaceId,
      name: row.name,
      description: current?.description ?? "",
      origin: row.origin,
      stage: row.stage,
      ...(row.author_bot_id ? { authorBotId: row.author_bot_id as BotId } : {}),
      assignments: this.assignments(row.id),
      version: row.current_version,
      ...(current ? { sha256: current.sha256 } : {}),
      pinned: row.pinned === 1,
      ...(row.provenance ? { provenance: row.provenance } : {}),
      ...(used.at ? { lastUsedAt: used.at } : {}),
      listedSince: row.listed_since,
      pendingVersions: pending,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  get(id: string): Skill | undefined {
    const row = this.row(id);
    return row ? this.toSkill(row) : undefined;
  }

  mustGet(id: string): Skill {
    const skill = this.get(id);
    if (!skill) throw new DeskmatesError("not_found", "Skill not found", { skillId: id });
    return skill;
  }

  byName(workspaceId: WorkspaceId, name: string): Skill | undefined {
    const row = this.db
      .prepare("SELECT * FROM skills WHERE workspace_id = ? AND name = ?")
      .get(workspaceId, name) as SkillRow | undefined;
    return row ? this.toSkill(row) : undefined;
  }

  list(workspaceId: WorkspaceId): Skill[] {
    const rows = this.db
      .prepare("SELECT * FROM skills WHERE workspace_id = ? ORDER BY name")
      .all(workspaceId) as SkillRow[];
    return rows.map((row) => this.toSkill(row));
  }

  /**
   * One page of a workspace's skills by `name, id` (#113), optionally narrowed to a name or
   * current description containing `q` (case-insensitive for ASCII), with the filtered total.
   */
  page(
    workspaceId: WorkspaceId,
    q: string,
    offset: number,
    limit: number,
  ): { items: Skill[]; total: number } {
    const from = `FROM skills s
      LEFT JOIN skill_versions v ON v.skill_id = s.id AND v.version = s.current_version
      WHERE s.workspace_id = ?
        AND (? = '' OR instr(lower(s.name), ?) > 0 OR instr(lower(COALESCE(v.description, '')), ?) > 0)`;
    const needle = q.toLowerCase();
    const args = [workspaceId, needle, needle, needle];
    const { total } = this.db.prepare(`SELECT COUNT(*) AS total ${from}`).get(...args) as {
      total: number;
    };
    const rows = this.db
      .prepare(`SELECT s.* ${from} ORDER BY s.name, s.id LIMIT ? OFFSET ?`)
      .all(...args, limit, offset) as SkillRow[];
    return { items: rows.map((row) => this.toSkill(row)), total };
  }

  /** Skills enabled for one bot (decision 1, decision 3), current versions only, by name. */
  enabledFor(workspaceId: WorkspaceId, botId: BotId): Skill[] {
    const rows = this.db
      .prepare(
        `SELECT s.* FROM skills s
         WHERE s.workspace_id = ? AND s.current_version > 0 AND (
           (s.stage = 'provisional' AND s.author_bot_id = ?)
           OR (s.stage = 'active' AND (s.author_bot_id = ?
             OR EXISTS (SELECT 1 FROM skill_assignments a WHERE a.skill_id = s.id AND a.bot_id = ?))))
         ORDER BY s.name`,
      )
      .all(workspaceId, botId, botId, botId) as SkillRow[];
    return rows.map((row) => this.toSkill(row));
  }

  insert(input: NewSkill): string {
    const id = newId("skill");
    this.db
      .prepare(
        `INSERT INTO skills (id, workspace_id, name, origin, stage, author_bot_id, current_version,
           pinned, provenance, listed_since, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.workspaceId,
        input.name,
        input.origin,
        input.stage,
        input.authorBotId ?? null,
        input.provenance ?? null,
        input.at,
        input.at,
        input.at,
      );
    return id;
  }

  /** Appends the next immutable version and returns its number. */
  addVersion(skillId: string, input: NewSkillVersion): number {
    const { next } = this.db
      .prepare(
        "SELECT COALESCE(MAX(version), 0) + 1 AS next FROM skill_versions WHERE skill_id = ?",
      )
      .get(skillId) as { next: number };
    this.db
      .prepare(
        `INSERT INTO skill_versions (skill_id, version, op, files_json, sha256, description, review,
           hold_reasons_json, findings_json, source_run_id, derived_from_json, by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        skillId,
        next,
        input.op,
        JSON.stringify(sortSkillFiles(input.files)),
        input.sha256,
        input.description,
        input.review,
        JSON.stringify(input.holdReasons ?? []),
        JSON.stringify(input.findings ?? []),
        input.sourceRunId ?? null,
        JSON.stringify(input.derivedFrom ?? []),
        input.by,
        input.at,
      );
    return next;
  }

  version(skillId: string, version: number): SkillVersion | undefined {
    const row = this.db
      .prepare("SELECT * FROM skill_versions WHERE skill_id = ? AND version = ?")
      .get(skillId, version) as VersionRow | undefined;
    return row ? toVersion(row) : undefined;
  }

  versions(skillId: string): SkillVersion[] {
    const rows = this.db
      .prepare("SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY version")
      .all(skillId) as VersionRow[];
    return rows.map(toVersion);
  }

  /** Newest versions first (`version DESC`), `limit + 1` rows below `before` (#113). */
  versionRows(skillId: string, limit: number, before?: number): SkillVersion[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM skill_versions WHERE skill_id = ? AND (? IS NULL OR version < ?) ORDER BY version DESC LIMIT ?",
      )
      .all(skillId, before ?? null, before ?? null, limit + 1) as VersionRow[];
    return rows.map(toVersion);
  }

  /**
   * One keyset page of "needs your confirmation" (#113), oldest first by
   * `created_at, skill name, version` (a name is unique in its workspace); `limit + 1` rows.
   */
  pendingRows(
    workspaceId: WorkspaceId,
    limit: number,
    after?: readonly [string, string, number],
  ): (SkillVersion & { name: string })[] {
    const rows = this.db
      .prepare(
        `SELECT v.*, s.name AS name FROM skill_versions v JOIN skills s ON s.id = v.skill_id
         WHERE s.workspace_id = ? AND v.review = 'pending'
           AND (? IS NULL OR v.created_at > ? OR (v.created_at = ? AND (s.name > ?
             OR (s.name = ? AND v.version > ?))))
         ORDER BY v.created_at, s.name, v.version LIMIT ?`,
      )
      .all(
        workspaceId,
        after?.[0] ?? null,
        after?.[0] ?? null,
        after?.[0] ?? null,
        after?.[1] ?? null,
        after?.[1] ?? null,
        after?.[2] ?? null,
        limit + 1,
      ) as (VersionRow & { name: string })[];
    return rows.map((row) => ({ ...toVersion(row), name: row.name }));
  }

  pendingCount(workspaceId: WorkspaceId): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM skill_versions v JOIN skills s ON s.id = v.skill_id
           WHERE s.workspace_id = ? AND v.review = 'pending'`,
        )
        .get(workspaceId) as { n: number }
    ).n;
  }

  /** Versions waiting in "needs your confirmation", for one workspace. */
  pending(workspaceId: WorkspaceId): (SkillVersion & { name: string })[] {
    const rows = this.db
      .prepare(
        `SELECT v.*, s.name AS name FROM skill_versions v JOIN skills s ON s.id = v.skill_id
         WHERE s.workspace_id = ? AND v.review = 'pending' ORDER BY v.created_at, s.name`,
      )
      .all(workspaceId) as (VersionRow & { name: string })[];
    return rows.map((row) => ({ ...toVersion(row), name: row.name }));
  }

  setReview(skillId: string, version: number, review: SkillReview, by: string, at: string): void {
    this.db
      .prepare(
        "UPDATE skill_versions SET review = ?, decided_by = ?, decided_at = ? WHERE skill_id = ? AND version = ?",
      )
      .run(review, by, at, skillId, version);
  }

  setCurrent(skillId: string, version: number, at: string): void {
    this.db
      .prepare(
        "UPDATE skills SET current_version = ?, listed_since = ?, updated_at = ? WHERE id = ?",
      )
      .run(version, at, at, skillId);
  }

  setStage(skillId: string, stage: SkillStage, at: string, relisted: boolean): void {
    this.db
      .prepare(
        relisted
          ? "UPDATE skills SET stage = ?, listed_since = ?, updated_at = ? WHERE id = ?"
          : "UPDATE skills SET stage = ?, updated_at = ? WHERE id = ?",
      )
      .run(...(relisted ? [stage, at, at, skillId] : [stage, at, skillId]));
  }

  setPinned(skillId: string, pinned: boolean, at: string): void {
    this.db
      .prepare("UPDATE skills SET pinned = ?, updated_at = ? WHERE id = ?")
      .run(pinned ? 1 : 0, at, skillId);
  }

  assignments(skillId: string): SkillAssignment[] {
    const rows = this.db
      .prepare(
        "SELECT bot_id, basis, by, created_at FROM skill_assignments WHERE skill_id = ? ORDER BY created_at, bot_id",
      )
      .all(skillId) as {
      bot_id: string;
      basis: SkillAssignmentBasis;
      by: string;
      created_at: string;
    }[];
    return rows.map((r) => ({
      botId: r.bot_id as BotId,
      basis: r.basis,
      by: r.by,
      createdAt: r.created_at,
    }));
  }

  assign(
    skillId: string,
    botId: BotId,
    basis: SkillAssignmentBasis,
    by: string,
    at: string,
    evidence?: unknown,
  ): void {
    this.db
      .prepare(
        `INSERT INTO skill_assignments (skill_id, bot_id, basis, evidence_json, by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (skill_id, bot_id) DO UPDATE SET basis = excluded.basis,
           evidence_json = excluded.evidence_json, by = excluded.by, created_at = excluded.created_at`,
      )
      .run(skillId, botId, basis, evidence === undefined ? null : JSON.stringify(evidence), by, at);
  }

  unassignAllExcept(skillId: string, keep: readonly BotId[]): void {
    const rows = this.assignments(skillId);
    const drop = this.db.prepare("DELETE FROM skill_assignments WHERE skill_id = ? AND bot_id = ?");
    for (const a of rows) if (!keep.includes(a.botId)) drop.run(skillId, a.botId);
  }

  /** The measured use (decision 6): latest timestamp wins, every event counts once. */
  recordUse(skillId: string, botId: BotId, at: string): void {
    this.db
      .prepare(
        `INSERT INTO skill_usage (skill_id, bot_id, last_used_at, uses) VALUES (?, ?, ?, 1)
         ON CONFLICT (skill_id, bot_id) DO UPDATE SET uses = uses + 1,
           last_used_at = MAX(last_used_at, excluded.last_used_at)`,
      )
      .run(skillId, botId, at);
  }

  usedBy(skillId: string, botId: BotId): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM skill_usage WHERE skill_id = ? AND bot_id = ?")
        .get(skillId, botId) !== undefined
    );
  }

  /** Listed or stale skills that disuse can move (decision 6); pinned ones are left out. */
  sweepable(): { id: string; stage: SkillStage; idleSince: string }[] {
    return this.db
      .prepare(
        `SELECT s.id, s.stage,
           MAX(s.listed_since, COALESCE((SELECT MAX(u.last_used_at) FROM skill_usage u
             WHERE u.skill_id = s.id), '')) AS idleSince
         FROM skills s
         WHERE s.pinned = 0 AND s.current_version > 0
           AND s.stage IN ('provisional', 'active', 'stale')`,
      )
      .all() as { id: string; stage: SkillStage; idleSince: string }[];
  }
}
