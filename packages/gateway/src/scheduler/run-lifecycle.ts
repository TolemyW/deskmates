import { createHash } from "node:crypto";
import { APPROVAL_PRESENTATION } from "../approvals/presentation.js";
import { ACTIVITY_SUMMARY } from "../ledger/activity-summaries.js";
// What happens at the two ends of a run (design v0.3 §5 steps 2 and 8): preparing the sidecar's
// StartRunRequest with a fresh short-lived token, and turning the sidecar's RunEnded into ledger
// rows, the bot's reply message, `last_seen_seq` and the terminal status.

import {
  type ApprovalId,
  type BotId,
  type DeferredAction,
  DeskmatesError,
  type MessageId,
  PARKED_RUN_STATUSES,
  RUN_ERROR_BUDGET,
  RUN_ERROR_DEADLINE,
  RUN_ERROR_NO_REPLY,
  type ReasoningOverrides,
  type RunEnded,
  type RunId,
  type RunResumePayload,
  type RunStatus,
  type StartRunRequest,
  type Thread,
  type ThreadId,
  type ToolAction,
  type TriggerPayload,
  type WorkspaceId,
  botHomeDir,
  canTransition,
  isEffortLevel,
  isExecuting,
  isRecordedReasoning,
  isTerminal,
  isThinkingConfig,
  learnedFromSuggestions,
  overridesOfRecorded,
  recordedSkillSet,
  resolveReasoning,
} from "@deskmates/contracts";
import { approvalAttachment } from "../approvals/broker.js";
import { continuationPlan, settleContinuationByMode } from "../approvals/continuation-mode.js";
import { APPROVAL_EXPIRY_ACTOR } from "../approvals/expiry.js";
import { cliSurfaceStart } from "../config/cli-surface.js";
import type { GatewayContext } from "../context.js";
import { nowIso } from "../db/ids.js";
import { newId } from "../db/ids.js";
import type { GatewayEvent } from "../events/bus.js";
import { MARKED_WRONG_REASON, RunMarkStore } from "../ledger/run-marks.js";
import { refreshRunUsageSummary } from "../ledger/run-usage-summaries.js";
import type { RunRecord } from "../ledger/runs.js";
import { isConsolidationRun } from "../memory/consolidation.js";
import { indexConfig } from "../memory/index.js";
import { writeLearnedItems } from "../memory/learned-writes.js";
import { modelJobSettings } from "../model-jobs/model-jobs.js";
import { visionStart } from "../model-jobs/vision-policy.js";
import { recordAuthoredSkills } from "../skills/authoring.js";
import { STARTER_SKILL_PACK } from "../skills/starter-catalog.js";
import { announceDelegationOutcome } from "../threads/delegation-outcomes.js";
import { type DeliveryGroup, buildDelivery } from "../threads/delivery.js";
import { recordFinalReplyRouting, roundFacts } from "../threads/round-delivery.js";
import { modelUpstreamsOf } from "./model-upstream-freeze.js";
import { rulesChangedSince } from "./rule-revisions.js";
import { continuationPolicy, freezeRunLimits, runMaxTurns } from "./run-limits.js";
import { recordTimelineMark } from "./run-timeline-marks.js";
import { sidecarToolsFor } from "./sidecar-tools.js";

/**
 * The dimensions that identify "the same action" across processes (ADR-0002 amendment 2, "the
 * decision survives a stale snapshot"). A browser `ref` is local to one MCP session, so the
 * resumed process matches its retry on these instead. Absent fields stay absent: a `targetOrigin`
 * of `undefined` on the wire would look like a claim that the action had none.
 */
function deferredActionOf(action: ToolAction): DeferredAction {
  return {
    toolName: action.toolName,
    ...(action.targetOrigin === undefined ? {} : { targetOrigin: action.targetOrigin }),
    ...(action.argumentPattern === undefined ? {} : { argumentPattern: action.argumentPattern }),
  };
}

export interface PreparedStart {
  run: RunRecord;
  request: StartRunRequest;
  token: string;
}

export class RunLifecycle {
  constructor(private readonly ctx: GatewayContext) {}

  /**
   * The models this run is actually started on, stamped on the row before the sidecar sees it.
   * `runs.config_json` already carried `defaultModel` and `defaultCheapModel`, the Gateway-wide
   * knobs; that is not the same thing as the models a bot with an override ran on, and a trace
   * exported later read the bot's *current* models instead, which change the moment the bot is
   * re-pointed (QA-03). The run's own record is the only immutable answer, so both are written
   * here, once, at start. The cheap model is a knob of the same kind: a bot that runs its
   * subagents on a different small model has to be attributable from the run row alone.
   */
  private effectiveModels(
    run: RunRecord,
    bot: { model?: string; cheapModel?: string; workspaceId: WorkspaceId },
  ): Pick<StartRunRequest, "model" | "cheapModel" | "fallbackModel" | "visionPolicy"> {
    const recordedModel = typeof run.config.model === "string" ? run.config.model : undefined;
    const recordedCheap =
      typeof run.config.cheapModel === "string" ? run.config.cheapModel : undefined;
    // A resume is a second process of the same run: it keeps the models attempt 1 ran on, even if
    // the bot was re-pointed while the run sat waiting for a human.
    const model = recordedModel ?? bot.model ?? this.ctx.config.defaultModel;
    const cheapModel = recordedCheap ?? bot.cheapModel ?? this.ctx.config.cheapModel;
    // ADR-0023 decision 3: FALLBACK_MODEL is frozen the same way; `null` records "none", so a
    // run started without one does not gain one when the Gateway is reconfigured.
    const fallbackRecorded = "fallbackModel" in run.config;
    const fallbackModel = fallbackRecorded
      ? typeof run.config.fallbackModel === "string"
        ? run.config.fallbackModel
        : undefined
      : this.ctx.config.fallbackModel;
    // ADR-0023 amendment 1, decision 9, and amendment 2, decision 11: what was known about the
    // frozen model and what the run does with images, both kept on resume.
    const vision = visionStart(this.ctx, run, bot.workspaceId, model);
    const patch = {
      ...(recordedModel === undefined ? { model } : {}),
      ...(recordedCheap === undefined ? { cheapModel } : {}),
      ...(fallbackRecorded ? {} : { fallbackModel: fallbackModel ?? null }),
      ...("modelUpstreams" in run.config
        ? {}
        : { modelUpstreams: modelUpstreamsOf(this.ctx, [model, cheapModel, fallbackModel]) }),
      ...vision.patch,
    };
    if (Object.keys(patch).length > 0) this.ctx.runs.setConfig(run.id, patch);
    return {
      model,
      cheapModel,
      ...(fallbackModel === undefined ? {} : { fallbackModel }),
      ...vision.request,
    };
  }

  /**
   * The reasoning settings this run is started with, resolved and recorded once, like the models:
   * the run's own `effort` / `thinking` keys (a per-run experiment), else the bot's, else the SDK
   * default. "Unset" is a real configuration (SDK 0.3.278 sends adaptive thinking at effort high
   * on its own; see the 2026-09-30 thinking parameter probe under `docs/design/`), so the row records
   * `sdk-default` rather than a value the Gateway never chose, and the request carries no key at
   * all so the SDK's default stays exactly that. A resume keeps attempt 1's record.
   */
  private effectiveReasoning(
    run: RunRecord,
    bot: ReasoningOverrides,
  ): Pick<StartRunRequest, "effort" | "thinking"> {
    const recorded = run.config.reasoning;
    if (isRecordedReasoning(recorded)) return overridesOfRecorded(recorded);
    // A per-run experiment sets the keys on the run's config at create time; a value that is not
    // a valid level or shape is ignored rather than forwarded to the SDK unvalidated.
    const runOverrides: ReasoningOverrides = {};
    if (isEffortLevel(run.config.effort)) runOverrides.effort = run.config.effort;
    if (isThinkingConfig(run.config.thinking)) runOverrides.thinking = run.config.thinking;
    const resolved = resolveReasoning(runOverrides, bot);
    this.ctx.runs.setConfig(run.id, { reasoning: resolved.recorded });
    return resolved.request;
  }

  /**
   * ADR-0013 items 4 and 5: the start request says how many integration connections the
   * workspace can use, and nothing else about the runtime (no URL, token or secret).
   */
  private integrationSettings(
    workspaceId: WorkspaceId,
  ): Pick<StartRunRequest, "integrationConnections"> {
    const count = this.ctx.integrations.usableConnectionCount(workspaceId);
    return count > 0 ? { integrationConnections: count } : {};
  }

  /**
   * ADR-0021 amendment 2: the open tasks linked to this run or its thread. `task_deliver` is
   * offered only when there is one; the delivery route re-checks the link on every call.
   */
  private taskSettings(runId: RunId): Pick<StartRunRequest, "deliverableTasks"> {
    const tasks = this.ctx.tasks.deliverableFor(runId);
    return tasks.length > 0 ? { deliverableTasks: tasks } : {};
  }

  private browserSettings(
    run: RunRecord,
  ): Pick<
    StartRunRequest,
    "browserCoordination" | "browserSnapshotMode" | "browserExecutionMode" | "browserCodeApproval"
  > {
    return {
      // ADR-0002 amendment 5: from the run row, so a resume keeps the tiers it started with.
      ...(run.config.browserCodeApproval === "effects-v1"
        ? { browserCodeApproval: "effects-v1" as const }
        : {}),
      ...(run.config.browserExecutionMode === "vision-cli-v2"
        ? { browserExecutionMode: "vision-cli-v2" as const }
        : {}),
      ...(run.config.browserSnapshotMode === "inline-v2"
        ? { browserSnapshotMode: "inline-v2" as const }
        : {}),
      ...(run.config.browserCoordinationMode === "origin-v2"
        ? {
            browserCoordination: {
              mode: "origin-v2" as const,
              deadlineAt: new Date(
                Date.now() + this.ctx.config.runTimeoutSeconds * 1000,
              ).toISOString(),
            },
          }
        : {}),
    };
  }

  /**
   * Issue #88 (ADR-0004 amendment 1): the run row's working-directory mode, not the Gateway's
   * current one, so every process of a run starts where its first one did. `shared`, and a row
   * from before the knob, send nothing and the sidecar keeps `/work`. ADR-0036: the workspace's
   * stored settings win over the Gateway knob (default `per-bot`, ADR-0038) and are frozen on the
   * first process, with, when the lane notice is on, the bot's other live lane.
   */
  private workdirSettings(
    run: RunRecord,
    workspaceId: WorkspaceId,
  ): Pick<StartRunRequest, "workdirMode" | "otherLaneRun"> {
    return this.ctx.workdir.startFields(this.ctx.runs, run, workspaceId);
  }

  /**
   * The pinned memory index for a fresh start (ADR-0011 decision 9) and whether the run begins
   * tainted (decision 3). The index's budgets and exact version set go on the run row first, so
   * replay can rebuild what the run was given (decision 12).
   */
  private memoryStart(
    run: RunRecord,
    workspaceId: WorkspaceId,
    threadId: ThreadId | undefined,
    sessionTainted: boolean,
  ): Pick<StartRunRequest, "memoryIndex" | "sessionTainted"> {
    const tainted = sessionTainted ? { sessionTainted: true as const } : {};
    if (run.config.memoryVersion !== 1) return tainted;
    const index = this.ctx.memory.indexForRun(run.id, workspaceId, run.botId, threadId);
    this.ctx.runs.setConfig(run.id, { memory: indexConfig(index) });
    this.ctx.events.append({
      runId: run.id,
      kind: "memory_index",
      payload: { ...index.counts, budgets: index.budgets, versionSet: index.versionSet },
    });
    return { memoryIndex: index, ...tainted };
  }

  /**
   * The run's skill set (ADR-0015 decision 1): computed and recorded in `runs.config_json` on the
   * first attempt; a later attempt of the same run gets exactly the recorded set back, so a
   * resumed SDK session never sees a different set than it started with (decision 7). A set that
   * can no longer be rebuilt (a version gone or changed) starts the attempt with no skills and
   * says so in the ledger rather than substituting another set.
   */
  private skillStart(run: RunRecord, workspaceId: WorkspaceId): Pick<StartRunRequest, "skills"> {
    const { ctx } = this;
    const recorded = recordedSkillSet(run.config);
    if (recorded) {
      if (
        recorded.starterPack?.version !== STARTER_SKILL_PACK.version ||
        recorded.starterPack.sha256 !== STARTER_SKILL_PACK.sha256
      ) {
        ctx.events.append({
          runId: run.id,
          kind: "log",
          payload: {
            source: "skills",
            op: "starter_pack_unavailable",
            pack: recorded.starterPack,
          },
        });
        return {};
      }
      const rebuilt = ctx.skills.rebuildSet(workspaceId, recorded.set);
      if (!rebuilt) {
        ctx.events.append({
          runId: run.id,
          kind: "log",
          payload: { source: "skills", op: "set_unavailable", set: recorded.set },
        });
        return {};
      }
      return rebuilt.length > 0 ? { skills: rebuilt } : {};
    }
    const set = ctx.skills.skillSetFor(workspaceId, run.botId);
    const refs = set.map(({ skillId, name, version, sha256 }) => ({
      skillId,
      name,
      version,
      sha256,
    }));
    ctx.runs.setConfig(run.id, {
      skills: {
        version: 1,
        set: refs,
        starterPack: { version: STARTER_SKILL_PACK.version, sha256: STARTER_SKILL_PACK.sha256 },
      },
    });
    return set.length > 0 ? { skills: set } : {};
  }

  /**
   * Skills a run's summary reported (ADR-0015 decision 2): stored or held for a consolidation
   * run, refused on the record for any other run, which never writes a skill.
   */
  private recordSkills(run: RunRecord, ended: RunEnded): void {
    const { ctx } = this;
    const proposals = ended.summary?.skills ?? [];
    if (proposals.length === 0) return;
    if (!isConsolidationRun(run)) {
      ctx.events.append({
        runId: run.id,
        kind: "log",
        payload: {
          source: "skills",
          op: "refused",
          count: proposals.length,
          reason: "skills are written only by a consolidation run",
        },
      });
      return;
    }
    // Re-read: this transaction has just stamped the run's taint on its config.
    const current = ctx.runs.mustGet(run.id);
    const outcomes = recordAuthoredSkills(
      ctx.skills,
      {
        id: run.id,
        botId: run.botId,
        workspaceId: ctx.bots.mustGet(run.botId).workspaceId,
        config: current.config,
      },
      proposals,
    );
    ctx.events.append({ runId: run.id, kind: "log", payload: { source: "skills", outcomes } });
  }

  /**
   * The roster of a group wake (ADR-0005 amendment 2, decision 12), or nothing for a one-member
   * thread and for a run created under `walk-v1`. The run row's own knob decides, not the
   * Gateway's current one, so a run is delivered the way it was routed. The roster and the
   * norm are for chat threads; a bus thread keeps routing context version 1.
   */
  private deliveryGroup(run: RunRecord, thread: Thread): DeliveryGroup | undefined {
    const { ctx } = this;
    // A run created before the knob existed has no value: it was routed by the walk. `round-v1`
    // keeps the roster and adds its round facts (ADR-0005 amendment 6).
    const routing = run.config.groupRouting;
    if (routing !== "owner-v1" && routing !== "round-v1") return undefined;
    const members = ctx.threads.members(thread.id);
    if (members.length < 2 || thread.kind !== "chat") return undefined;
    const bots = ctx.bots.list(thread.workspaceId);
    const roles = new Map(bots.map((bot) => [bot.id, bot.role]));
    // Workspace names, not current members: one who passed may have been removed since.
    const names = new Map(bots.map((bot) => [bot.id, bot.name]));
    const walk = ctx.walks.activeForRun(run.id);
    const request = walk?.mode === "first_taker" ? ctx.messages.get(walk.messageId) : undefined;
    const order = walk && request ? ctx.walks.members(walk.messageId) : [];
    const name = (botId: BotId): string => names.get(botId) ?? botId;
    return {
      members: members.map((member) => ({
        botId: member.botId,
        name: member.name,
        role: roles.get(member.botId) ?? "",
      })),
      ...(thread.ownerBotId ? { ownerBotId: thread.ownerBotId } : {}),
      ...(walk && request
        ? {
            offer: {
              messageSeq: request.seq,
              passed: order.slice(0, walk.nextMemberIndex).map(name),
              remaining: order.slice(walk.nextMemberIndex + 1).map(name),
            },
          }
        : {}),
      ...(routing === "round-v1" ? roundFacts(ctx, run, name) : {}),
    };
  }

  /** queued → running: issue a token, build the payload, record what was delivered. */
  start(run: RunRecord): PreparedStart {
    const { ctx } = this;
    if (run.status === "waiting_approval" || run.status === "waiting_continuation")
      return this.resume(run);
    if (
      run.triggerKind === "cron" ||
      run.triggerKind === "manual" ||
      run.triggerKind === "webhook" ||
      run.triggerKind === "welcome"
    )
      return this.startTrigger(run);
    if (run.triggerKind !== "thread_message" || !run.threadId) {
      throw new DeskmatesError("validation", `trigger ${run.triggerKind} has no thread`, {
        runId: run.id,
      });
    }
    const bot = ctx.bots.mustGet(run.botId);
    const thread = ctx.threads.mustGet(run.threadId);
    const member = ctx.threads.member(thread.id, run.botId);
    if (!member) {
      throw new DeskmatesError("validation", "bot is not a member of the thread", {
        runId: run.id,
        botId: run.botId,
        threadId: thread.id,
      });
    }
    const botNames = new Map(ctx.bots.list(thread.workspaceId).map((b) => [b.id, b.name]));
    const group = this.deliveryGroup(run, thread);
    const groupGuidance = group ? ("owner-v1" as const) : undefined;
    const delivery = buildDelivery(
      thread,
      run.botId,
      ctx.messages.list(thread.id, member.lastSeenSeq),
      botNames,
      ctx.config.threadPayloadMaxTokens,
      ctx.messages.get(run.triggerRef as MessageId),
      group,
    );
    // Issue #21: a must-reply message anywhere in the delivered slice (a coalesced wake carries
    // several) decides how a silent end is recorded. Fixed here, so a resume keeps it.
    const mustReply = ctx.messages.mustReplyInRange(
      thread.id,
      member.lastSeenSeq,
      delivery.deliveredSeq,
    );
    ctx.runs.setConfig(run.id, {
      threadContextVersion: group ? 2 : 1,
      ...(groupGuidance ? { groupGuidance } : {}),
      // With `deliveredSeq`, the slice this run was delivered: what it was asked, by whom, is read
      // from it (ADR-0016, `delegationsOf`), not only from the message that woke it.
      deliveredFromSeq: member.lastSeenSeq,
      ...(mustReply ? { mustReply: true } : {}),
    });
    const issued = ctx.tokens.issue(run.id);
    const models = this.effectiveModels(run, bot);
    const reasoning = this.effectiveReasoning(run, bot);
    const started = this.setStatus(run.id, "running", { deliveredSeq: delivery.deliveredSeq });
    const base = ctx.gatewayBaseUrl();
    const tasks = this.taskSettings(run.id);
    const request: StartRunRequest = {
      runId: run.id,
      botId: run.botId,
      botName: bot.name,
      workspaceId: bot.workspaceId,
      threadId: thread.id,
      botHomeDir: botHomeDir(bot.name),
      attempt: started.attempt,
      trigger: delivery.trigger,
      ...(groupGuidance ? { groupGuidance } : {}),
      ...models,
      ...reasoning,
      modelBaseUrl: base,
      modelAuthToken: issued.token,
      gatewayBaseUrl: base,
      shortWaitSeconds: ctx.config.shortWaitSeconds,
      maxTurns: freezeRunLimits(ctx, run, bot.workspaceId),
      ...this.browserSettings(run),
      ...cliSurfaceStart(run.config),
      ...this.workdirSettings(run, bot.workspaceId),
      egressAllowlist: ctx.workspaces.mustGet(bot.workspaceId).egressAllowlist,
      connectors: bot.connectors,
      ...this.integrationSettings(bot.workspaceId),
      tools: sidecarToolsFor(
        true,
        run.config,
        bot.connectors.length > 0,
        ctx.integrations.usableConnectionCount(bot.workspaceId) > 0,
        tasks.deliverableTasks !== undefined,
      ),
      ...tasks,
    };
    const sdkSessionId = ctx.sessions.get(run.botId, thread.id);
    if (sdkSessionId !== undefined) {
      request.sdkSessionId = sdkSessionId;
      ctx.runs.setConfig(run.id, {
        usageSessionFingerprint: createHash("sha256").update(sdkSessionId).digest("hex"),
      });
    }
    Object.assign(request, this.skillStart(run, bot.workspaceId));
    Object.assign(
      request,
      this.memoryStart(
        run,
        bot.workspaceId,
        thread.id,
        sdkSessionId !== undefined && ctx.sessions.tainted(run.botId, thread.id),
      ),
    );
    return { run: started, request, token: issued.token };
  }

  /**
   * queued → running for a cron, webhook or welcome run. Cron and webhook have no thread;
   * welcome owns the Bot's new private thread so its normal final reply lands there. All three
   * carry host-authored trigger text captured with the run and start a fresh SDK session.
   */
  private startTrigger(run: RunRecord): PreparedStart {
    const { ctx } = this;
    const payload = run.triggerPayload ?? {};
    // A manual run is its cron entry run now (ADR-0043 decision 6): the bot gets the entry's
    // prompt as a scheduled task; the run row keeps the `manual` trigger and who asked.
    const trigger: TriggerPayload =
      run.triggerKind === "cron" || run.triggerKind === "manual"
        ? { kind: "cron", prompt: typeof payload.prompt === "string" ? payload.prompt : "" }
        : run.triggerKind === "webhook"
          ? { kind: "webhook", body: typeof payload.body === "string" ? payload.body : "" }
          : { kind: "welcome", prompt: typeof payload.prompt === "string" ? payload.prompt : "" };
    if (run.triggerKind === "welcome" && !run.threadId) {
      throw new DeskmatesError("validation", "welcome run has no private thread", {
        runId: run.id,
      });
    }
    const bot = ctx.bots.mustGet(run.botId);
    const issued = ctx.tokens.issue(run.id);
    const models = this.effectiveModels(run, bot);
    const reasoning = this.effectiveReasoning(run, bot);
    const started = this.setStatus(run.id, "running");
    const base = ctx.gatewayBaseUrl();
    const tasks = this.taskSettings(run.id);
    const request: StartRunRequest = {
      runId: run.id,
      botId: run.botId,
      botName: bot.name,
      workspaceId: bot.workspaceId,
      ...(run.threadId ? { threadId: run.threadId } : {}),
      botHomeDir: botHomeDir(bot.name),
      attempt: started.attempt,
      trigger,
      ...(run.config.runType === APPROVAL_PRESENTATION ? { presentationSummary: true } : {}),
      ...(run.config.runType === ACTIVITY_SUMMARY
        ? { presentationSummary: true, presentationKind: "activity" as const }
        : {}),
      ...modelJobSettings(ctx, run, bot),
      ...models,
      ...reasoning,
      modelBaseUrl: base,
      modelAuthToken: issued.token,
      gatewayBaseUrl: base,
      shortWaitSeconds: ctx.config.shortWaitSeconds,
      maxTurns: freezeRunLimits(ctx, run, bot.workspaceId),
      ...this.browserSettings(run),
      ...cliSurfaceStart(run.config),
      ...this.workdirSettings(run, bot.workspaceId),
      egressAllowlist: ctx.workspaces.mustGet(bot.workspaceId).egressAllowlist,
      connectors: bot.connectors,
      ...this.integrationSettings(bot.workspaceId),
      tools: sidecarToolsFor(
        run.threadId !== undefined,
        run.config,
        bot.connectors.length > 0,
        ctx.integrations.usableConnectionCount(bot.workspaceId) > 0,
        tasks.deliverableTasks !== undefined,
      ),
      ...tasks,
      // A consolidation over untrusted sources starts tainted, so the sidecar stamps its items
      // untrusted as well; the Gateway gates them regardless (ADR-0011 decision 8).
      ...this.skillStart(run, bot.workspaceId),
      ...this.memoryStart(
        run,
        bot.workspaceId,
        run.threadId,
        run.config.consolidationUntrusted === true,
      ),
    };
    return { run: started, request, token: issued.token };
  }

  /**
   * waiting_approval → running: a second sidecar process for the same run row (ADR-0002
   * amendment 2, "resume keeps the ledger whole"). `attempt` goes up by one, which is what keeps
   * the resumed process's events — whose seq restarts at 1 — out of the redelivery filter. The
   * decision is carried as the trigger and applies to the deferred `toolUseId` only.
   */
  private resume(run: RunRecord): PreparedStart {
    const { ctx } = this;
    const payload = run.resumePayload;
    if (!payload?.sdkSessionId || (!payload.approvalId && !payload.budget)) {
      throw new DeskmatesError("validation", "parked run has no resumable payload", {
        runId: run.id,
      });
    }
    const trigger = this.resumeTrigger(run, payload);
    const bot = ctx.bots.mustGet(run.botId);
    const issued = ctx.tokens.issue(run.id);
    const models = this.effectiveModels(run, bot);
    const reasoning = this.effectiveReasoning(run, bot);
    const started = this.setStatus(run.id, "running", {
      attempt: run.attempt + 1,
      startedAt: nowIso(),
    });
    const base = ctx.gatewayBaseUrl();
    const tasks = this.taskSettings(run.id);
    const request: StartRunRequest = {
      runId: run.id,
      botId: run.botId,
      botName: bot.name,
      workspaceId: bot.workspaceId,
      ...(run.threadId ? { threadId: run.threadId } : {}),
      botHomeDir: botHomeDir(bot.name),
      sdkSessionId: payload.sdkSessionId,
      attempt: started.attempt,
      trigger,
      // The resumed process gets the prompt the first one had (ADR-0005 amendment 2, item 13).
      ...(run.config.groupGuidance === "owner-v1" ? { groupGuidance: "owner-v1" as const } : {}),
      ...models,
      ...reasoning,
      modelBaseUrl: base,
      modelAuthToken: issued.token,
      gatewayBaseUrl: base,
      shortWaitSeconds: ctx.config.shortWaitSeconds,
      maxTurns: runMaxTurns(run.config, ctx.config.maxTurns),
      ...this.browserSettings(run),
      ...cliSurfaceStart(run.config),
      ...this.workdirSettings(run, bot.workspaceId),
      egressAllowlist: ctx.workspaces.mustGet(bot.workspaceId).egressAllowlist,
      connectors: bot.connectors,
      ...this.integrationSettings(bot.workspaceId),
      tools: sidecarToolsFor(
        run.threadId !== undefined,
        run.config,
        bot.connectors.length > 0,
        ctx.integrations.usableConnectionCount(bot.workspaceId) > 0,
        tasks.deliverableTasks !== undefined,
      ),
      ...tasks,
      // A resumed process gets the skill set attempt 1 recorded (ADR-0015 decision 7).
      ...this.skillStart(run, bot.workspaceId),
      // The parked process may have read untrusted content before it parked; its session has it.
      ...(run.config.memoryTainted === true ||
      run.config.consolidationUntrusted === true ||
      (run.threadId !== undefined && ctx.sessions.tainted(run.botId, run.threadId))
        ? { sessionTainted: true }
        : {}),
      ...(Array.isArray(run.config.sessionDoNotLearnReasons)
        ? {
            sessionDoNotLearnReasons: run.config.sessionDoNotLearnReasons as NonNullable<
              StartRunRequest["sessionDoNotLearnReasons"]
            >,
          }
        : {}),
    };
    ctx.events.append(
      trigger.kind === "budget_continuation"
        ? {
            runId: run.id,
            kind: "log",
            payload: { source: "budget", phase: "resumed", attempt: started.attempt },
          }
        : {
            runId: run.id,
            kind: "approval",
            payload: {
              phase: "resumed",
              approvalId: "approvalId" in trigger ? trigger.approvalId : undefined,
              attempt: started.attempt,
            },
          },
    );
    return { run: started, request, token: issued.token };
  }

  /** The decision a resumed process starts from: an approval, a continuation, or the budget's. */
  private resumeTrigger(run: RunRecord, payload: RunResumePayload): TriggerPayload {
    const handoff =
      typeof run.config.handoffPath === "string" ? { handoffPath: run.config.handoffPath } : {};
    // ADR-0032 decision 7: an Admin continued the budget park; there is no approval.
    if (payload.budget) return { kind: "budget_continuation", ...handoff };
    const approval = this.ctx.approvals.mustGet(payload.approvalId as ApprovalId);
    if (!approval.decision) {
      throw new DeskmatesError("validation", "approval is not decided yet", {
        runId: run.id,
        approvalId: approval.id,
      });
    }
    return payload.continuation
      ? { kind: "continuation", approvalId: approval.id, decision: "continue", ...handoff }
      : {
          kind: "approval",
          approvalId: approval.id,
          decision: approval.decision,
          ...(payload.toolUseId ? { toolUseId: payload.toolUseId } : {}),
          // ADR-0002 amendment 3, A7: an expiry tells the model nobody approved it, and not to work
          // around it; other decisions resume exactly as before.
          ...(approval.decidedBy === APPROVAL_EXPIRY_ACTOR && approval.reason
            ? { reason: approval.reason }
            : {}),
          ...(payload.currentOrigin ? { currentOrigin: payload.currentOrigin } : {}),
          deferredAction: deferredActionOf(approval.action),
        };
  }

  /**
   * The sidecar reported the end of its process. Usage, session id, the reply message, the status
   * transition and `last_seen_seq` are one SQLite transaction: a failure anywhere leaves the run
   * exactly as it was, instead of a usage row for a run that is still `running`. The SSE frames
   * are published after the commit, in the order they were produced.
   */
  ended(runId: RunId, ended: RunEnded): RunRecord {
    const { ctx } = this;
    const run = ctx.runs.mustGet(runId);
    // A `stalled` run may end like a running one (issue #9); its route revives it first anyway.
    if (!isExecuting(run.status)) {
      throw new DeskmatesError("invalid_transition", `run ${runId} is ${run.status}, not running`, {
        runId,
        from: run.status,
      });
    }
    const published: GatewayEvent[] = [];
    const result = ctx.bus.batch(() => {
      const committed = ctx.db.transaction((): RunRecord => {
        // The SDK reports cumulative totals over the thread's session; the usage store turns them
        // into this run's delta (ADR-0002 item 5).
        const session = run.threadId
          ? { botId: run.botId, threadId: run.threadId, sdkSessionId: ended.sdkSessionId }
          : undefined;
        // Keyed on the run's current attempt: a resumed process reports the session's totals again,
        // and its delta is that attempt's share, not a correction of the parked attempt's.
        ctx.usage.record(
          runId,
          run.attempt,
          ended.usage,
          run.startedAt ?? run.createdAt,
          session,
          ended.sdkSessionId,
        );
        // ADR-0032 decision 3: the final receipt's difference is charged in the same commit. An
        // accounting fault must not undo the run's end; the next observation charges the rest.
        try {
          ctx.budget.charge(runId);
        } catch (err) {
          ctx.events.append({
            runId,
            kind: "log",
            payload: { source: "budget", phase: "charge_failed", error: String(err) },
          });
        }
        // ADR-0032 amendment 1 decision 12: the attempt's usage summary is stored once, here; a
        // later usage write invalidates it and the next Costs reader recomputes it. Reporting
        // only: a fault here leaves the summary missing for the reader, not the run unended.
        try {
          refreshRunUsageSummary(ctx.db, runId);
        } catch {
          // The Costs reader computes a missing summary.
        }
        // ADR-0018 decision 2: rules are read against the window this usage is filed under (the
        // run's creation day, as the cost report does), inside the same transaction, and the
        // frames go out with the rest after the commit.
        if (ended.usage.length > 0) {
          const createdAt = new Date(run.createdAt);
          for (const alert of ctx.costAlerts.evaluate(runId, run.botId, createdAt)) {
            published.push({ type: "cost_alert", alert });
          }
        }
        // Facts only the sidecar knows (M3 context plan, Phase 1). A resumed attempt rebuilds its
        // system prompt, so the key holds the latest attempt's hash; each attempt's own is in its
        // `context_sections` event.
        const configPatch: Record<string, unknown> = {};
        if (ended.systemPromptSha256) configPatch.systemPromptSha256 = ended.systemPromptSha256;
        if (ended.systemPromptStaticSha256)
          configPatch.systemPromptStaticSha256 = ended.systemPromptStaticSha256;
        if (ended.maxContextTokens) configPatch.claudeCodeMaxContextTokens = ended.maxContextTokens;
        // ADR-0011 decision 3: taint is sticky across the attempts of one run and the runs of one
        // SDK session, so a resume starts where the parked process left off.
        const tainted =
          run.config.memoryTainted === true || ended.taint?.taintedAtTurn !== undefined;
        if (ended.taint) configPatch.memoryTaint = { ...ended.taint };
        if (ended.taint?.doNotLearnReasons) {
          configPatch.sessionDoNotLearnReasons = [
            ...new Set([
              ...(Array.isArray(run.config.sessionDoNotLearnReasons)
                ? run.config.sessionDoNotLearnReasons
                : []),
              ...ended.taint.doNotLearnReasons,
            ]),
          ];
        }
        if (tainted) configPatch.memoryTainted = true;
        if (Object.keys(configPatch).length > 0) ctx.runs.setConfig(runId, configPatch);
        // A SOUL or MEMORY save during this run cleared the bot's sessions; the next run starts a
        // fresh one under the new rules instead of resuming this one (ADR-0043 decision 3).
        if (ended.sdkSessionId && run.threadId && !rulesChangedSince(ctx, run.botId, run.config)) {
          ctx.sessions.set(run.botId, run.threadId, ended.sdkSessionId, tainted);
        }
        const sessionPatch = ended.sdkSessionId ? { sdkSessionId: ended.sdkSessionId } : {};

        if (run.config.runType === APPROVAL_PRESENTATION) {
          const text =
            ended.outcome === "completed" ? ended.summary?.reply.trim().slice(0, 700) : undefined;
          const approval = ctx.approvals.get(
            run.config.approvalId as import("@deskmates/contracts").ApprovalId,
          );
          if (text && approval && approval.botId === run.botId) {
            const updated = ctx.approvals.setDisplaySummary(approval.id, text, run.id);
            published.push({
              type: "approval",
              ...(updated.threadId ? { threadId: updated.threadId } : {}),
              approval: updated,
            });
          }
          return this.applyStatus(published, runId, text ? "succeeded" : "failed", {
            ...(ended.summary ? { summary: ended.summary } : {}),
            ...(!text ? { error: ended.error ?? "No presentation summary returned" } : {}),
          });
        }

        // ADR-0033 decision 6/7: only the summary row changes; clients reload on this job's end.
        if (run.config.runType === ACTIVITY_SUMMARY) {
          const text = ended.outcome === "completed" ? ended.summary?.reply.trim() : undefined;
          ctx.activitySummaries.complete(run, text);
          return this.applyStatus(published, runId, text ? "succeeded" : "failed", {
            ...(ended.summary ? { summary: ended.summary } : {}),
            ...(!text ? { error: ended.error ?? "No activity summary returned" } : {}),
          });
        }

        // ADR-0023 amendment 1: a model job settles its own row and is never parked.
        const jobStatus = ctx.modelJobs.complete(run, ended, (message) =>
          published.push({ type: "thread_message", threadId: message.threadId, message }),
        );
        if (jobStatus) {
          return this.applyStatus(published, runId, jobStatus, {
            ...(ended.summary ? { summary: ended.summary } : {}),
            ...(jobStatus === "failed"
              ? { error: ended.error ?? "model job returned nothing" }
              : {}),
          });
        }

        // ADR-0032 decision 6: the model proxy refused this attempt for budget. Its process ended
        // however it ended; the run is checkpointed, not finished. Approval and turn parks keep
        // their own path, held by the open budget park.
        const budgetPark = ctx.budget.openPark(runId);
        if (
          budgetPark?.checkpoint === "model_call" &&
          budgetPark.attempt === run.attempt &&
          ended.outcome !== "deferred" &&
          ended.outcome !== "turns_exhausted"
        ) {
          return this.parkForBudget(published, run, ended, sessionPatch);
        }

        if (ended.outcome === "turns_exhausted") {
          return this.parkExhausted(published, run, ended, sessionPatch);
        }
        if (ended.outcome === "failed") {
          this.recordSkippedLearned(run, ended, "failed_run");
          // The sidecar writes a partial-work handoff on failure too (issue #68); keep its path
          // where the outcome notice and a later continuation look for it.
          if (ended.handoffPath) ctx.runs.setConfig(runId, { handoffPath: ended.handoffPath });
          const failed = this.applyStatus(published, runId, "failed", {
            ...sessionPatch,
            error: ended.error ?? "sidecar reported failure",
            ...(ended.summary ? { summary: ended.summary } : {}),
          });
          // ADR-0016 amendment 1: a failed delegate is announced to its delegator.
          announceDelegationOutcome(ctx, failed, published);
          return failed;
        }
        if (ended.outcome === "deferred") {
          const resumePayload = {
            sdkSessionId: ended.sdkSessionId ?? "",
            ...(ended.pendingApprovalId ? { approvalId: ended.pendingApprovalId } : {}),
            ...(ended.pendingToolUseId ? { toolUseId: ended.pendingToolUseId } : {}),
            // Kept so the resumed process knows which page the decision was taken about; a wrong
            // origin is worse than none, so an absent one stays absent.
            ...(ended.currentOrigin ? { currentOrigin: ended.currentOrigin } : {}),
          };
          // The wait the approval is now in is the parked one, not the live one. A decision that
          // arrived while the sidecar was exiting is already on the row; the scheduler's next pass
          // sees the parked run with a decided approval and resumes it.
          if (ended.pendingApprovalId && ctx.approvals.get(ended.pendingApprovalId)) {
            ctx.approvals.setWaitMode(ended.pendingApprovalId, "deferred");
          }
          return this.applyStatus(published, runId, "waiting_approval", {
            ...sessionPatch,
            resumePayload,
          });
        }
        this.recordLearned(run, ended);
        this.recordSkills(run, ended);
        const reply = ended.summary?.reply.trim() ?? "";
        if (reply && run.threadId) {
          const existing = ctx.messages.findRunReply(run.threadId, run.id, run.botId, reply);
          if (existing) {
            ctx.events.append({
              runId: run.id,
              kind: "log",
              payload: { source: "final_reply", op: "deduplicated", messageId: existing.id },
            });
          } else {
            const message = ctx.router.postFromRun(run, reply);
            published.push({ type: "thread_message", threadId: run.threadId, message });
            recordFinalReplyRouting(ctx, run, message);
          }
        }
        const silent = run.threadId !== undefined && !reply;
        // Issue #21: a silent end on a must-reply message is `failed` / `no_reply`, unless the run
        // answered in the thread through `thread_post`. It still saw the slice, so `last_seen_seq`
        // advances as for `silent`: the flag changes the recorded outcome, never who is woken.
        const noReply =
          silent &&
          run.config.mustReply === true &&
          !ctx.messages.postedByRun(run.id).some((m) => m.threadId === run.threadId);
        const terminal: RunStatus = noReply ? "failed" : silent ? "silent" : "succeeded";
        const final = this.applyStatus(published, runId, terminal, {
          ...sessionPatch,
          ...(ended.summary ? { summary: ended.summary } : {}),
          ...(noReply ? { error: RUN_ERROR_NO_REPLY } : {}),
        });
        this.advanceLastSeen(final, noReply);
        // ADR-0016 amendment 1: the delegator learns the outcome after the reply (if any) is in
        // the thread, so a wake the reply already queued coalesces with the notice's.
        announceDelegationOutcome(ctx, final, published);
        return final;
      })();
      for (const event of published) ctx.bus.publish(event);
      return committed;
    });
    this.release(runId);
    // ADR-0037: the sidecar's end was taken; a non-empty reply is in the thread from now on.
    recordTimelineMark(ctx, runId, run.attempt, "run_ended", {
      outcome: ended.outcome,
      replyPosted:
        ended.outcome === "completed" &&
        run.threadId !== undefined &&
        (ended.summary?.reply.trim() ?? "") !== "",
    });
    ctx.router.runEnded(result);
    return result;
  }

  private recordSkippedLearned(run: RunRecord, ended: RunEnded, reason: string): void {
    const summary = ended.summary;
    if (!summary) return;
    const count = summary.learned?.length ?? summary.memorySuggestions.length;
    for (let ordinal = 0; ordinal < count; ordinal++) {
      this.ctx.events.append({
        runId: run.id,
        kind: "memory_skipped",
        payload: { ordinal, reason },
      });
    }
  }

  /**
   * ADR-0032 decision 6: checkpoint a run the budget stopped at a model call. The session and the
   * handoff are kept, no reply is posted and nothing is learned; Continue resumes it. Without a
   * session there is nothing to resume, and the run fails with the typed reason.
   */
  private parkForBudget(
    published: GatewayEvent[],
    run: RunRecord,
    ended: RunEnded,
    sessionPatch: { sdkSessionId?: string },
  ): RunRecord {
    const { ctx } = this;
    if (ended.handoffPath) ctx.runs.setConfig(run.id, { handoffPath: ended.handoffPath });
    this.recordSkippedLearned(run, ended, "budget_park");
    ctx.events.append({
      runId: run.id,
      kind: "log",
      payload: {
        source: "budget",
        phase: ended.sdkSessionId ? "checkpointed" : "unresumable",
        reportedOutcome: ended.outcome,
        handoffPath: ended.handoffPath ?? null,
      },
    });
    if (!ended.sdkSessionId) {
      const failed = this.applyStatus(published, run.id, "failed", {
        error: RUN_ERROR_BUDGET,
        ...(ended.summary ? { summary: ended.summary } : {}),
      });
      announceDelegationOutcome(ctx, failed, published);
      return failed;
    }
    return this.applyStatus(published, run.id, "waiting_continuation", {
      ...sessionPatch,
      resumePayload: { sdkSessionId: ended.sdkSessionId, continuation: true, budget: true },
    });
  }

  private parkExhausted(
    published: GatewayEvent[],
    run: RunRecord,
    ended: RunEnded,
    sessionPatch: { sdkSessionId?: string },
  ): RunRecord {
    const { ctx } = this;
    const continuationCount = Number(run.config.continuationCount ?? 0);
    const handoffPath = ended.handoffPath;
    const source =
      run.triggerKind === "thread_message"
        ? ctx.messages.get(run.triggerRef as MessageId)
        : undefined;
    const delegatorBot = source?.authorKind === "bot" ? source.authorId : undefined;
    // ADR-0002 amendment 3, A9: a threadless run's notices go to its bot's private chat.
    const noticeThreadId = ctx.broker.noticeThread(run).threadId;
    const notify = (body: string, attachmentId?: ApprovalId): void => {
      if (!noticeThreadId) return;
      const posted = ctx.router.postSystem(
        noticeThreadId,
        body,
        attachmentId ? [approvalAttachment(attachmentId)] : [],
        delegatorBot
          ? { wakeOnly: delegatorBot as RunRecord["botId"] }
          : { wakeExcept: run.botId, wakeOnly: run.botId },
      );
      published.push({ type: "thread_message", threadId: noticeThreadId, message: posted.message });
      if (attachmentId) ctx.approvals.setMessage(attachmentId, posted.message.id);
      for (const wake of posted.runs)
        published.push({ type: "run_status", threadId: noticeThreadId, run: wake });
    };
    // ADR-0016 amendment 2: the limit and window the run froze at its first start.
    const policy = continuationPolicy(run.config);
    // ADR-0002 amendment 6, D6: in approve_all the mode continues within the limit, and past it
    // the reviewer decides instead of the run failing.
    const plan = continuationPlan(ctx, run, continuationCount, Boolean(ended.sdkSessionId));
    if (plan === "fail" || !ended.sdkSessionId) {
      notify(
        `${ctx.bots.mustGet(run.botId).name} exhausted its turn budget and cannot continue. Handoff: ${handoffPath ?? "unavailable"}.`,
      );
      return this.applyStatus(published, run.id, "failed", {
        ...sessionPatch,
        error: ended.sdkSessionId
          ? `turn budget exhausted after ${policy.limit === 2 ? "two" : String(policy.limit)} continuations`
          : "turn budget exhausted without a resumable session",
      });
    }
    const approvalId = newId("approval") as ApprovalId;
    const expiresAt = new Date(Date.now() + policy.windowHours * 60 * 60 * 1000).toISOString();
    ctx.runs.setConfig(run.id, {
      continuationCount,
      continuationLimit: policy.limit,
      continuationExpiresAt: expiresAt,
      handoffPath: handoffPath ?? null,
      continuationBeyondLimit: plan === "review",
    });
    const left =
      policy.limit === null
        ? "no continuation limit"
        : `${policy.limit - continuationCount} of ${policy.limit} continuations left`;
    const capSource =
      typeof run.config.limitSources === "object" && run.config.limitSources !== null
        ? String((run.config.limitSources as Record<string, unknown>).maxTurns ?? "gateway")
        : "gateway";
    ctx.approvals.create({
      id: approvalId,
      runId: run.id,
      botId: run.botId,
      ...(noticeThreadId ? { threadId: noticeThreadId } : {}),
      action: {
        toolName: "__run_continuation__",
        input: {},
        argumentSummary: `Handoff: ${handoffPath ?? "unavailable"}`,
      },
      riskLevel: "L0",
      ...(source?.body ? { instruction: source.body } : {}),
    });
    ctx.approvals.setWaitMode(approvalId, "deferred");
    const usage = ctx.usage.list(run.id);
    const tokens = usage.reduce(
      (total, item) =>
        total +
        item.inputTokens +
        item.outputTokens +
        item.cacheReadTokens +
        item.cacheCreateTokens,
      0,
    );
    const observedTurns = ctx.events
      .list(run.id)
      .filter((event) => event.kind === "turn_usage").length;
    const askPeople = (): void =>
      notify(
        `${ctx.bots.mustGet(run.botId).name} reached the ${String(run.config.maxTurns ?? ctx.config.maxTurns)}-turn attempt limit (${capSource}). ${observedTurns} model turns observed across ${run.attempt} attempt(s); ${usage.length ? `${tokens} recorded tokens` : "token usage unavailable"}. Delegating message: ${source?.id ?? run.triggerRef}. Handoff: ${handoffPath ?? "unavailable"}. ${left}. Continue or stop by ${expiresAt}. A bot member can decide with approval_decide(${approvalId}, allow_once) to continue or approval_decide(${approvalId}, deny) to stop.`,
        approvalId,
      );
    if (plan === "ask") askPeople();
    const approval = ctx.approvals.mustGet(approvalId);
    published.push(
      noticeThreadId
        ? { type: "approval", threadId: noticeThreadId, approval }
        : { type: "approval", approval },
    );
    ctx.events.append({
      runId: run.id,
      kind: "approval",
      payload: {
        phase: "continuation_requested",
        approvalId,
        expiresAt,
        handoffPath: handoffPath ?? null,
        continuationLimit: policy.limit,
        continuationWindowHours: policy.windowHours,
      },
    });
    const parked = this.applyStatus(published, run.id, "waiting_continuation", {
      ...sessionPatch,
      resumePayload: { sdkSessionId: ended.sdkSessionId, approvalId, continuation: true },
    });
    if (plan === "ask") return parked;
    if (!settleContinuationByMode(ctx, published, parked, approvalId, plan)) askPeople();
    return ctx.runs.mustGet(run.id);
  }

  /**
   * ADR-0011 decision 2: what the run learned is classified, deduplicated and applied or gated,
   * inside the run's end-of-run transaction. The outcome of every item goes to the ledger. A run
   * from an older sidecar has only `memorySuggestions`; they become untrusted bot candidates.
   */
  private recordLearned(run: RunRecord, ended: RunEnded): void {
    const { ctx } = this;
    const summary = ended.summary;
    if (!summary) return;
    // ADR-0042 decision 3: a run an operator marked wrong before it ended learns nothing.
    if (new RunMarkStore(ctx.db).isWrong(run.id)) {
      this.recordSkippedLearned(run, ended, MARKED_WRONG_REASON);
      return;
    }
    const learned =
      summary.learned && summary.learned.length > 0
        ? summary.learned
        : learnedFromSuggestions(summary.memorySuggestions, 1);
    if (learned.length === 0) return;
    const rules = ctx.memory.rulesFor(run.botId);
    const outcomes = isConsolidationRun(run)
      ? ctx.memory.consolidation.onEnded(run, learned, rules)
      : writeLearnedItems(
          ctx.memory.stores,
          {
            runId: run.id,
            botId: run.botId,
            workspaceId: ctx.bots.mustGet(run.botId).workspaceId,
            ...(run.threadId ? { threadId: run.threadId } : {}),
            rules,
            createdAt: run.createdAt,
          },
          learned,
        );
    ctx.events.append({
      runId: run.id,
      kind: "log",
      payload: { source: "learned_memory", outcomes },
    });
    for (const outcome of outcomes) {
      if (outcome.outcome === "skipped") {
        ctx.events.append({
          runId: run.id,
          kind: "memory_skipped",
          payload: { ordinal: outcome.ordinal, reason: outcome.reason },
        });
      }
    }
  }

  /**
   * The sidecar process ended (or could not start) without a `run_ended`. A queued run fails
   * too: left queued it would hold its lane on every scheduler pass.
   */
  fail(runId: RunId, error: string): RunRecord | undefined {
    const run = this.ctx.runs.get(runId);
    if (!run || !canTransition(run.status, "failed")) return run;
    const failed = this.setStatus(runId, "failed", { error });
    // ADR-0016 amendment 1: a crash, a deadline or a start failure is still an outcome the
    // delegator has to hear about; this is the case that left the chief waiting in the trial.
    const published: GatewayEvent[] = [];
    announceDelegationOutcome(this.ctx, failed, published);
    for (const event of published) this.ctx.bus.publish(event);
    this.release(runId);
    this.ctx.router.runEnded(failed);
    return failed;
  }

  /**
   * The run's thread passed its deadline (issue #21): any non-terminal run becomes `cancelled`
   * with reason `deadline`. Its token and browser lock go, which frees the lane and stops a live
   * sidecar from reaching the Gateway or the model; a `run_ended` it sends later is refused.
   */
  cancelPastDeadline(runId: RunId): RunRecord | undefined {
    const run = this.ctx.runs.get(runId);
    if (!run || !canTransition(run.status, "cancelled")) return run;
    const cancelled = this.setStatus(runId, "cancelled", { error: RUN_ERROR_DEADLINE });
    this.release(runId);
    this.ctx.router.runEnded(cancelled);
    return cancelled;
  }

  /**
   * An operator stops a run (issue #15). Allowed from every non-terminal state (design v0.3 §4);
   * a terminal run is `invalid_transition` carrying its status, and nothing is written. The
   * status, the closing of the run's pending approvals and the ledger note are one transaction;
   * the frames go out after it commits. Releasing the run revokes its token, which is the stop
   * request a live sidecar sees: every internal route and the model proxy refuse it from then on.
   * Killing a process that ignores it is the scheduler's job.
   */
  cancel(runId: RunId, cancelledBy: string): RunRecord {
    const { ctx } = this;
    const current = ctx.runs.mustGet(runId);
    if (isTerminal(current.status)) {
      throw new DeskmatesError("invalid_transition", `run ${runId} is already ${current.status}`, {
        runId,
        status: current.status,
      });
    }
    const published: GatewayEvent[] = [];
    const cancelled = ctx.bus.batch(() => {
      const committed = ctx.db.transaction((): RunRecord => {
        const run = this.applyStatus(published, runId, "cancelled");
        ctx.broker.closeForRun(runId, "system:cancel", `run cancelled by ${cancelledBy}`);
        ctx.events.append({
          runId,
          kind: "log",
          payload: { source: "cancel", by: cancelledBy, from: current.status },
        });
        return run;
      })();
      for (const event of published) ctx.bus.publish(event);
      return committed;
    });
    this.release(runId);
    ctx.router.runEnded(cancelled);
    return cancelled;
  }

  private setStatus(
    runId: RunId,
    to: RunStatus,
    patch: Parameters<GatewayContext["runs"]["transition"]>[2] = {},
  ): RunRecord {
    const published: GatewayEvent[] = [];
    const run = this.applyStatus(published, runId, to, patch);
    for (const event of published) this.ctx.bus.publish(event);
    return run;
  }

  /** The transition itself; the SSE frame is queued on `published` for the caller to flush. */
  private applyStatus(
    published: GatewayEvent[],
    runId: RunId,
    to: RunStatus,
    patch: Parameters<GatewayContext["runs"]["transition"]>[2] = {},
  ): RunRecord {
    const run = this.ctx.runs.transition(runId, to, patch);
    published.push(
      run.threadId
        ? { type: "run_status", threadId: run.threadId, run }
        : { type: "run_status", run },
    );
    return run;
  }

  /**
   * ADR-0005 definitions: advance on succeeded / silent only, never on failed. A `no_reply`
   * failure is a silent end recorded differently (issue #21), so it advances too.
   */
  private advanceLastSeen(run: RunRecord, noReply = false): void {
    if (!run.threadId || run.deliveredSeq === undefined) return;
    if (run.status === "failed" && !noReply) return;
    this.ctx.threads.advanceLastSeen(run.threadId, run.botId, run.deliveredSeq);
  }

  /** Token and browser lock go away with the process, on terminal and parked states alike. */
  private release(runId: RunId): void {
    const run = this.ctx.runs.mustGet(runId);
    if (isTerminal(run.status) || PARKED_RUN_STATUSES.has(run.status)) {
      this.ctx.tokens.revokeForRun(runId);
      this.ctx.locks.releaseForRun(runId);
      // Trash archival hides the bot from active queries before it cancels open runs. Release is
      // cleanup for that cancellation, so it must still resolve the archived bot's workspace.
      const bot = this.ctx.bots.mustGetIncludingArchived(run.botId);
      const origin = this.ctx.originQueue
        .list(bot.workspaceId)
        .find((entry) => entry.runId === runId);
      this.ctx.originQueue.releaseForRun(runId);
      if (origin)
        this.ctx.events.append({
          runId,
          kind: "log",
          payload: {
            source: "browser_origin",
            op: "released",
            origin: origin.origin,
            reason: run.status,
            waitedMs: Math.max(
              0,
              Date.parse(origin.grantedAt ?? new Date().toISOString()) -
                Date.parse(origin.queuedAt),
            ),
          },
        });
    }
  }
}
