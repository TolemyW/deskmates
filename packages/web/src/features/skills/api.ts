// Skills (ADR-0015): Members read; installing, reviewing and spreading a skill is an Admin's.

import type {
  BotId,
  RecordedStarterSkillPack,
  Skill,
  SkillFile,
  SkillStage,
  SkillVersion,
  StarterSkill,
  WorkspaceId,
} from "@deskmates/contracts";
import { type HttpTransport, query, stripUndefined } from "../../platform/http-transport.js";

/**
 * The bundled starter catalog (whole, static) and one page of a workspace's skills by name, with
 * the filtered total and the size of "needs your confirmation" (ADR-0015, #113).
 */
export interface SkillsView {
  starterPack: RecordedStarterSkillPack;
  starterSkills: StarterSkill[];
  skills: Skill[];
  offset: number;
  limit: number;
  total: number;
  pendingTotal: number;
}

/** A skill version waiting in "needs your confirmation", with its skill's name. */
export type PendingSkillVersion = SkillVersion & { name: string };

export interface InstallSkillInput {
  files: SkillFile[];
  /** The hash the human reviewed; the Gateway refuses content that does not match it. */
  sha256: string;
  provenance?: string;
  botIds?: BotId[];
}

export interface InstalledSkill {
  skill: Skill;
  version: SkillVersion;
}

export interface SkillsApi {
  assignSkill(skillId: string, botIds: BotId[]): Promise<Skill>;
  confirmSkillVersion(skillId: string, version: number): Promise<Skill>;
  installSkill(workspaceId: WorkspaceId, input: InstallSkillInput): Promise<InstalledSkill>;
  /** One page of "needs your confirmation", oldest first, by cursor; `total` is the queue. */
  listPendingSkillVersions(
    workspaceId: WorkspaceId,
    filters?: { cursor?: string; limit?: number },
  ): Promise<{ pending: PendingSkillVersion[]; total: number; nextCursor?: string }>;
  /** Newest versions first; `nextCursor` reads older ones. */
  listSkillVersions(
    skillId: string,
    filters?: { cursor?: string; limit?: number },
  ): Promise<{ versions: SkillVersion[]; nextCursor?: string }>;
  listSkills(
    workspaceId: WorkspaceId,
    filters?: { q?: string; offset?: number; limit?: number },
  ): Promise<SkillsView>;
  rejectSkillVersion(skillId: string, version: number): Promise<Skill>;
  undoSkill(skillId: string): Promise<Skill>;
  updateSkill(skillId: string, patch: { stage?: SkillStage; pinned?: boolean }): Promise<Skill>;
}

export function createSkillsApi(t: HttpTransport): SkillsApi {
  const skill = (skillId: string) => `/api/skills/${encodeURIComponent(skillId)}`;
  return {
    async assignSkill(skillId, botIds) {
      return (await t.json<{ skill: Skill }>("POST", `${skill(skillId)}/assign`, { botIds })).skill;
    },
    async confirmSkillVersion(skillId, version) {
      return (
        await t.json<{ skill: Skill }>("POST", `${skill(skillId)}/versions/${version}/confirm`, {})
      ).skill;
    },
    installSkill(workspaceId, input) {
      return t.json<InstalledSkill>(
        "POST",
        `/api/workspaces/${encodeURIComponent(workspaceId)}/skills`,
        stripUndefined({ ...input }),
      );
    },
    listPendingSkillVersions(workspaceId, filters = {}) {
      return t.json(
        "GET",
        `/api/workspaces/${encodeURIComponent(workspaceId)}/skills/pending${query({ ...filters })}`,
      );
    },
    listSkillVersions(skillId, filters = {}) {
      return t.json("GET", `${skill(skillId)}/versions${query({ ...filters })}`);
    },
    listSkills(workspaceId, filters = {}) {
      return t.json<SkillsView>(
        "GET",
        `/api/workspaces/${encodeURIComponent(workspaceId)}/skills${query({ ...filters })}`,
      );
    },
    async rejectSkillVersion(skillId, version) {
      return (
        await t.json<{ skill: Skill }>("POST", `${skill(skillId)}/versions/${version}/reject`, {})
      ).skill;
    },
    async undoSkill(skillId) {
      return (await t.json<{ skill: Skill }>("POST", `${skill(skillId)}/undo`, {})).skill;
    },
    async updateSkill(skillId, patch) {
      return (await t.json<{ skill: Skill }>("PATCH", skill(skillId), stripUndefined({ ...patch })))
        .skill;
    },
  };
}
