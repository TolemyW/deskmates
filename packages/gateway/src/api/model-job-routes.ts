// Operator routes of the short model jobs (ADR-0023 amendment 1): a workspace's model
// capabilities and the vision probe Retry (issue #87), and SOUL proposals (issue #77). Reads never
// queue a job. Generating a proposal changes nothing; applying one is the canonical SOUL write.

import {
  type BotId,
  DeskmatesError,
  PARKED_RUN_STATUSES,
  SOUL_PROPOSAL_INSTRUCTION_MAX_CHARS,
  type WorkspaceId,
  decidedByHuman,
} from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import type { GatewayContext } from "../context.js";
import type { RunRecord } from "../ledger/runs.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import { requestActorId } from "./actor.js";
import { ensureCanonicalSoul } from "./memory-routes.js";
import { asRecord, requireString } from "./validate.js";

type WorkspaceParams = { Params: { id: string } };
type ProposalParams = { Params: { id: string; proposalId: string } };

function started(ctx: GatewayContext, scheduler: Scheduler, run: RunRecord | undefined): void {
  if (!run) return;
  ctx.bus.publish({ type: "run_status", run });
  scheduler.kick();
}

/** The same refusals as `PATCH /api/bots/:id/soul`: no write under a parked or live run. */
function assertSoulWritable(ctx: GatewayContext, botId: BotId, workspaceId: WorkspaceId): void {
  if (ctx.runs.list({ botId }).some((run) => PARKED_RUN_STATUSES.has(run.status)))
    throw new DeskmatesError(
      "invalid_transition",
      "Finish or cancel this bot's parked run before editing SOUL",
    );
  if (ctx.runs.listLiveInWorkspace(workspaceId).some((run) => run.botId === botId))
    throw new DeskmatesError("lane_busy", "Wait for this bot's current run before editing SOUL");
}

export function registerModelJobRoutes(
  app: FastifyInstance,
  ctx: GatewayContext,
  scheduler: Scheduler,
): void {
  app.get<WorkspaceParams>("/api/workspaces/:id/model-capabilities", async (request) => {
    const id = request.params.id as WorkspaceId;
    ctx.workspaces.mustGet(id);
    return { capabilities: ctx.modelJobs.vision.list(id) };
  });

  /** The explicit Retry: one probe now, bounded per key (decision 8). */
  app.post<WorkspaceParams>(
    "/api/workspaces/:id/model-capabilities/vision/probe",
    async (request, reply) => {
      const id = request.params.id as WorkspaceId;
      ctx.workspaces.mustGet(id);
      const body = asRecord(request.body);
      const model = requireString(body, "model");
      if (!ctx.modelJobs.vision.modelsInUse(id).includes(model))
        throw new DeskmatesError("validation", "model is not in use in this workspace", { model });
      const queued = ctx.modelJobs.vision.queue({
        workspaceId: id,
        model,
        trigger: "retry",
        requestedBy: decidedByHuman(requestActorId(request, body)),
      });
      started(ctx, scheduler, queued.run);
      return reply.code(202).send({ probe: queued.probe });
    },
  );

  app.post<WorkspaceParams>("/api/bots/:id/soul-proposals", async (request, reply) => {
    const bot = ctx.bots.mustGet(request.params.id as BotId);
    const body = asRecord(request.body);
    const instruction = requireString(body, "instruction").trim();
    if (instruction === "" || instruction.length > SOUL_PROPOSAL_INSTRUCTION_MAX_CHARS)
      throw new DeskmatesError(
        "validation",
        `instruction must be 1 to ${SOUL_PROPOSAL_INSTRUCTION_MAX_CHARS} characters`,
      );
    const base = await ensureCanonicalSoul(ctx, bot.id);
    const created = ctx.modelJobs.souls.create({
      bot,
      instruction,
      base,
      requestedBy: decidedByHuman(requestActorId(request, body)),
    });
    started(ctx, scheduler, created.run);
    return reply.code(202).send({ proposal: created.proposal });
  });

  app.get<ProposalParams>("/api/bots/:id/soul-proposals/:proposalId", async (request) => {
    const bot = ctx.bots.mustGet(request.params.id as BotId);
    return { proposal: ctx.modelJobs.souls.mustGetForBot(request.params.proposalId, bot.id) };
  });

  /**
   * Explicit confirm. Idempotent for an applied proposal; refused while the bot has a parked or
   * live run, and when SOUL has changed since the proposal's base, so an older preview can never
   * overwrite a newer edit: the operator regenerates against the current version instead.
   */
  app.post<ProposalParams>("/api/bots/:id/soul-proposals/:proposalId/apply", async (request) => {
    const bot = ctx.bots.mustGet(request.params.id as BotId);
    const proposal = ctx.modelJobs.souls.mustGetForBot(request.params.proposalId, bot.id);
    if (proposal.status === "applied")
      return { proposal, soul: await ensureCanonicalSoul(ctx, bot.id) };
    if (proposal.status !== "ready" || proposal.proposedBody === null)
      throw new DeskmatesError("invalid_transition", `proposal is ${proposal.status}`, {
        status: proposal.status,
      });
    assertSoulWritable(ctx, bot.id, bot.workspaceId);
    const current = await ensureCanonicalSoul(ctx, bot.id);
    assertSoulWritable(ctx, bot.id, bot.workspaceId);
    if (current.version !== proposal.baseVersion)
      throw new DeskmatesError(
        "invalid_transition",
        "SOUL changed since this proposal was generated; compare again before applying",
        { currentVersion: current.version, baseVersion: proposal.baseVersion },
      );
    const actor = decidedByHuman(requestActorId(request, request.body ?? {}));
    const body = proposal.proposedBody;
    return ctx.db.transaction(() => {
      const soul = ctx.bots.updateCanonicalSoul(bot.id, body, proposal.baseVersion);
      ctx.audit.record({
        action: "bot.update",
        actor,
        workspaceId: bot.workspaceId,
        targetKind: "bot",
        targetId: bot.id,
        before: { soulVersion: proposal.baseVersion },
        after: { soulVersion: soul.version, soulProposalId: proposal.id },
      });
      return { proposal: ctx.modelJobs.souls.markApplied(proposal, soul.version, actor), soul };
    })();
  });

  app.post<ProposalParams>("/api/bots/:id/soul-proposals/:proposalId/discard", async (request) => {
    const bot = ctx.bots.mustGet(request.params.id as BotId);
    const proposal = ctx.modelJobs.souls.mustGetForBot(request.params.proposalId, bot.id);
    const by = decidedByHuman(requestActorId(request, request.body ?? {}));
    return { proposal: ctx.modelJobs.souls.discard(proposal, by) };
  });
}
