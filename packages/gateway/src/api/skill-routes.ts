// Operator routes for skills (ADR-0015): Members read a workspace's skills, their versions and
// what waits in "needs your confirmation"; Admins install by hash, confirm or reject a held
// version, assign, promote, move a skill between stages, pin it and undo a version. Every write is
// recorded as the signed-in human. The route guard has already resolved the skill or workspace in
// the path to the caller's tenant (ROUTE_POLICY); handlers keep a skill inside its workspace.

import {
  type BotId,
  type CompareVerdict,
  DeskmatesError,
  PAGE_LIMIT_MAX,
  type PageLimitPolicy,
  type SkillFile,
  type SkillPromotionEvidence,
  type SkillStage,
  type WorkspaceId,
  decidedByHuman,
} from "@deskmates/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { GatewayContext } from "../context.js";
import { STARTER_SKILL_PACK, starterSkillCatalog } from "../skills/starter-catalog.js";
import { requestActorId } from "./actor.js";
import { keysetPage, parseCursorQuery, parseOffsetQuery } from "./pagination.js";
import { requestTenant } from "./route-policy.js";
import { asRecord, optionalString } from "./validate.js";

const VERDICTS: ReadonlySet<string> = new Set<CompareVerdict>([
  "better",
  "worse",
  "no difference",
  "inconclusive",
]);

function by(request: FastifyRequest): string {
  return decidedByHuman(requestActorId(request, request.body));
}

function versionParam(raw: string): number {
  const version = Number(raw);
  if (!Number.isSafeInteger(version) || version < 1)
    throw new DeskmatesError("validation", "Expected a positive skill version");
  return version;
}

/** Skills, the confirmation queue and versions: 25 a page, at most 100 (#113). */
export const SKILL_PAGE: PageLimitPolicy = { default: 25, max: PAGE_LIMIT_MAX };
const SEARCH_MAX = 200;

function searchOf(raw: unknown): string {
  if (raw === undefined) return "";
  if (typeof raw !== "string" || raw.length > SEARCH_MAX)
    throw new DeskmatesError("validation", "Invalid skill search", { field: "q" });
  return raw.trim();
}

function botIdsOf(raw: unknown): BotId[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || !raw.every((id) => typeof id === "string"))
    throw new DeskmatesError("validation", "botIds must be a list of bot ids");
  return raw as BotId[];
}

function filesOf(raw: unknown): SkillFile[] {
  if (!Array.isArray(raw)) throw new DeskmatesError("validation", "files must be a list");
  return raw.map((file) => {
    const f = asRecord(file, "file");
    if (typeof f.path !== "string" || typeof f.content !== "string")
      throw new DeskmatesError("validation", "every file needs a path and text content");
    return { path: f.path, content: f.content };
  });
}

function evidenceOf(raw: unknown): SkillPromotionEvidence | undefined {
  if (raw === undefined || raw === null) return undefined;
  const e = asRecord(raw, "evidence");
  const compare = asRecord(e.compare, "evidence.compare");
  if (
    typeof e.sha256 !== "string" ||
    typeof compare.passes !== "boolean" ||
    typeof compare.verdict !== "string" ||
    !VERDICTS.has(compare.verdict) ||
    !Number.isSafeInteger(compare.pairedTasks)
  )
    throw new DeskmatesError("validation", "evidence needs sha256, botIds and a compare result");
  return {
    sha256: e.sha256,
    botIds: botIdsOf(e.botIds),
    compare: {
      passes: compare.passes,
      verdict: compare.verdict as CompareVerdict,
      pairedTasks: compare.pairedTasks as number,
    },
  };
}

export function registerSkillRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  const { skills } = ctx;
  const workspaceOfSkill = (id: string): WorkspaceId => skills.store.mustGet(id).workspaceId;

  // The bundled starter catalog is static and comes whole; the workspace's own skills are one
  // page by name (offset, honest total, server search), and the confirmation queue is its own
  // keyset list (#113).
  app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>(
    "/api/workspaces/:id/skills",
    async (request) => {
      const workspace = ctx.workspaces.mustGet(request.params.id as WorkspaceId);
      const { offset, limit } = parseOffsetQuery(request.query, SKILL_PAGE);
      const q = searchOf(request.query.q);
      const page = skills.page(workspace.id, q, offset, limit);
      return {
        starterPack: { version: STARTER_SKILL_PACK.version, sha256: STARTER_SKILL_PACK.sha256 },
        starterSkills: starterSkillCatalog(),
        skills: page.items,
        offset,
        limit,
        total: page.total,
        pendingTotal: skills.store.pendingCount(workspace.id),
      };
    },
  );

  app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>(
    "/api/workspaces/:id/skills/pending",
    async (request) => {
      const workspace = ctx.workspaces.mustGet(request.params.id as WorkspaceId);
      const scope = ["skills.pending", workspace.id];
      const query = parseCursorQuery(request.query, SKILL_PAGE, scope, [
        "string",
        "string",
        "number",
      ]);
      const after = query.after as [string, string, number] | undefined;
      const page = keysetPage(
        skills.store.pendingRows(workspace.id, query.limit, after),
        query.limit,
        (row) => [row.createdAt, row.name, row.version],
        scope,
      );
      return {
        pending: page.items,
        total: skills.store.pendingCount(workspace.id),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    },
  );

  app.post<{ Params: { id: string } }>("/api/workspaces/:id/skills", async (request, reply) => {
    const workspace = ctx.workspaces.mustGet(request.params.id as WorkspaceId);
    const body = asRecord(request.body);
    const sha256 = optionalString(body, "sha256");
    if (!sha256)
      throw new DeskmatesError("validation", "sha256 of the reviewed content is required");
    const provenance = optionalString(body, "provenance");
    const installed = skills.install(
      workspace.id,
      {
        files: filesOf(body.files),
        sha256,
        ...(provenance ? { provenance } : {}),
        botIds: botIdsOf(body.botIds),
      },
      by(request),
    );
    return reply.code(201).send(installed);
  });

  // Newest first with "Load older" (#113): a long history is read in bounded pages.
  app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>(
    "/api/skills/:id/versions",
    async (request) => {
      const skill = skills.store.mustGet(request.params.id);
      const scope = ["skills.versions", skill.id];
      const query = parseCursorQuery(request.query, SKILL_PAGE, scope, ["number"]);
      const page = keysetPage(
        skills.store.versionRows(skill.id, query.limit, query.after?.[0] as number | undefined),
        query.limit,
        (row) => [row.version],
        scope,
      );
      return {
        versions: page.items,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    },
  );

  /** Exact versions by `skillId@version`, for trace export and replay (decision 7). */
  app.get<{ Querystring: { refs?: string } }>("/api/skills/versions", async (request) => {
    const refs = (request.query.refs ?? "").split(",").filter(Boolean).slice(0, 200);
    const tenantId = requestTenant(request);
    const versions = refs.flatMap((ref) => {
      const at = ref.lastIndexOf("@");
      const version = Number(ref.slice(at + 1));
      const skillId = ref.slice(0, at);
      if (at <= 0 || !Number.isSafeInteger(version)) return [];
      // Another tenant's skill is answered exactly like a missing one: left out.
      if (ctx.ownership.tenantOf("skill", skillId) !== tenantId) return [];
      const skill = skills.store.get(skillId);
      const found = skill ? skills.store.version(skillId, version) : undefined;
      return skill && found ? [{ ...found, name: skill.name }] : [];
    });
    return { versions };
  });

  app.post<{ Params: { id: string; version: string } }>(
    "/api/skills/:id/versions/:version/confirm",
    async (request) => ({
      skill: skills.confirm(
        workspaceOfSkill(request.params.id),
        request.params.id,
        versionParam(request.params.version),
        by(request),
      ),
    }),
  );

  app.post<{ Params: { id: string; version: string } }>(
    "/api/skills/:id/versions/:version/reject",
    async (request) => ({
      skill: skills.reject(
        workspaceOfSkill(request.params.id),
        request.params.id,
        versionParam(request.params.version),
        by(request),
      ),
    }),
  );

  app.post<{ Params: { id: string } }>("/api/skills/:id/assign", async (request) => {
    const body = asRecord(request.body);
    return {
      skill: skills.assign(
        workspaceOfSkill(request.params.id),
        request.params.id,
        botIdsOf(body.botIds),
        by(request),
      ),
    };
  });

  app.post<{ Params: { id: string } }>("/api/skills/:id/promote", async (request) => {
    const body = asRecord(request.body);
    const evidence = evidenceOf(body.evidence);
    return {
      skill: skills.promote(workspaceOfSkill(request.params.id), request.params.id, {
        by: by(request),
        ...(evidence ? { evidence } : {}),
      }),
    };
  });

  app.patch<{ Params: { id: string } }>("/api/skills/:id", async (request) => {
    const body = asRecord(request.body);
    const workspaceId = workspaceOfSkill(request.params.id);
    if (body.stage === undefined && body.pinned === undefined)
      throw new DeskmatesError("validation", "Nothing to change: send stage or pinned");
    if (body.pinned !== undefined && typeof body.pinned !== "boolean")
      throw new DeskmatesError("validation", "pinned must be true or false");
    let skill = skills.store.mustGet(request.params.id);
    if (body.stage !== undefined) {
      if (typeof body.stage !== "string")
        throw new DeskmatesError("validation", "stage must be a skill stage");
      skill = skills.setStage(workspaceId, skill.id, body.stage as SkillStage, by(request));
    }
    if (typeof body.pinned === "boolean")
      skill = skills.setPinned(workspaceId, skill.id, body.pinned, by(request));
    return { skill };
  });

  app.post<{ Params: { id: string } }>("/api/skills/:id/undo", async (request) => ({
    skill: skills.undo(workspaceOfSkill(request.params.id), request.params.id, by(request)),
  }));
}
