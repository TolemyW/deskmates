// ADR-0029: what the Gateway knows about a run the platform interrupted. A drain parks a run at a
// safe point (decision 2); a Gateway start parks every run the ledger lists as live, because no
// process of the new Gateway runs it (decision 4). These helpers read the ledger for what the
// resumed attempt needs: the session the attempt ran on, the call it may have been in the middle
// of (decision 5), and, when the session cannot be resumed, a handoff for a fresh one (decision 10).

import {
  type ApprovalId,
  type InterruptedToolCall,
  RUN_ERROR_GATEWAY_RESTARTED,
  type RiskLevel,
  type ThreadId,
  wrapUntrusted,
} from "@deskmates/contracts";
import type { GatewayContext } from "../context.js";
import type { GatewayEvent } from "../events/bus.js";
import type { RunRecord } from "../ledger/runs.js";

/** Decision 6: more than this many Gateway starts in the window trips the restart breaker. */
export const RESTART_BREAKER_LIMIT = 3;
export const RESTART_BREAKER_WINDOW_MINUTES = 10;

/** The `log` source of every platform-interruption event on a run's ledger. */
export const PLATFORM_LOG_SOURCE = "platform";

/** The `runs.config_json` keys this module and the lifecycle share. */
export const PLATFORM_CONFIG = {
  /** How many times the run was continued after a platform interruption (decision 6). */
  resumes: "platformResumes",
  /** The breaker held this parked run; an operator lets it go (decision 6). */
  held: "platformHeld",
  /** The call a restart interrupted, for the resumed attempt's notice (decision 5). */
  interrupted: "platformInterruptedCall",
  /** `{attempt, toolName, targetOrigin?, argumentPattern?}`: the L2 call to ask about again. */
  l2Recheck: "platformL2Recheck",
  /** The session could not be read; the next attempt starts a fresh one (decision 10). */
  freshSession: "platformFreshSession",
  /** The CLI build the SDK reported at init on the run's first attempt (decision 10). */
  sdkVersion: "sdkVersion",
} as const;

const RISK_LEVELS: ReadonlySet<unknown> = new Set(["L0", "L1", "L2"]);

/** How many platform continuations the run has had. */
export function platformResumesOf(run: RunRecord): number {
  const n = run.config[PLATFORM_CONFIG.resumes];
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/**
 * The SDK session the run's current attempt is on: the id its sidecar reported at SDK init in
 * this attempt (`SessionStartedReport`), else the one the attempt was resumed with. Undefined
 * means the attempt never reached the SDK, so a restart requeues it rather than resuming anything.
 */
export function sessionOfAttempt(_ctx: GatewayContext, run: RunRecord): string | undefined {
  if (run.sdkSessionId && run.config.sdkSessionAttempt === run.attempt) return run.sdkSessionId;
  return run.attempt > 1 && run.resumePayload?.sdkSessionId
    ? run.resumePayload.sdkSessionId
    : undefined;
}

/**
 * Decision 5: the call of the current attempt whose `tool_call` has no `tool_result`, the last one
 * when there are several. Its tier is the one the hook assigned: an approval row for the call
 * means the hook took it to L2, whatever the tool's static tier said, and the row's action holds
 * the call's stable dimensions.
 */
export function interruptedCallOf(
  ctx: GatewayContext,
  run: RunRecord,
): InterruptedToolCall | undefined {
  const calls = new Map<string, { toolName: string; riskLevel: RiskLevel }>();
  for (const e of ctx.events.list(run.id)) {
    if ((e.attempt ?? 1) !== run.attempt) continue;
    const id = e.payload.toolUseId;
    if (typeof id !== "string") continue;
    if (e.kind === "tool_call") {
      const level = RISK_LEVELS.has(e.payload.riskLevel)
        ? (e.payload.riskLevel as RiskLevel)
        : "L2";
      calls.set(id, { toolName: String(e.payload.toolName ?? "unknown"), riskLevel: level });
    } else if (e.kind === "tool_result") {
      calls.delete(id);
    }
  }
  const last = [...calls.entries()].at(-1);
  if (!last) return undefined;
  const [toolUseId, call] = last;
  const approval = ctx.approvals.forRun(run.id).find((a) => a.toolUseId === toolUseId);
  if (approval) {
    return {
      toolUseId,
      toolName: approval.action.toolName,
      riskLevel: "L2",
      ...(approval.action.targetOrigin === undefined
        ? {}
        : { targetOrigin: approval.action.targetOrigin }),
      ...(approval.action.argumentPattern === undefined
        ? {}
        : { argumentPattern: approval.action.argumentPattern }),
    };
  }
  return { toolUseId, ...call };
}

/** The notice a resumed attempt's first turn carries about its interrupted call (decision 5). */
export function interruptedCallNotice(call: InterruptedToolCall): string {
  const what = `The previous attempt was interrupted by a platform restart during tool call ${call.toolUseId} (${call.toolName}, ${call.riskLevel}).`;
  if (call.riskLevel === "L0")
    return `${what} The call was read-only and its result was lost; repeat it if you still need it.`;
  if (call.riskLevel === "L1")
    return `${what} Its outcome is unknown: the write may or may not have happened. Check the current state before you repeat it.`;
  return `${what} Its outcome is unknown and the platform will not repeat it. The approval that allowed it is spent: a call with the same target asks a human again.`;
}

/**
 * Decision 10: when the session cannot be resumed, the next attempt starts a fresh one from this
 * text, which the Gateway writes from the ledger alone. What a bot or a page wrote stays wrapped.
 */
export function freshSessionHandoff(ctx: GatewayContext, run: RunRecord): string {
  const lines: string[] = [
    `Gateway handoff for run ${run.id}: the earlier attempts' SDK session could not be resumed after a platform interruption, so this attempt starts a new session. Continue the same task; do not redo work the record below shows done.`,
  ];
  const from = run.config.deliveredFromSeq;
  if (run.threadId && typeof from === "number" && run.deliveredSeq !== undefined) {
    const slice = ctx.messages
      .list(run.threadId as ThreadId, from)
      .filter((m) => m.seq <= (run.deliveredSeq ?? 0));
    if (slice.length > 0) {
      lines.push("The thread messages this run was delivered:");
      for (const m of slice) {
        const author = m.authorKind === "human" ? "human" : m.authorKind;
        lines.push(
          m.authorKind === "system"
            ? `#${m.seq} system: ${m.body}`
            : `#${m.seq} ${author}: ${wrapUntrusted(`${m.authorKind}:${m.authorId}`, m.body)}`,
        );
      }
    }
  } else if (typeof run.triggerPayload?.prompt === "string") {
    lines.push(`The scheduled task: ${run.triggerPayload.prompt}`);
  } else if (typeof run.triggerPayload?.body === "string") {
    lines.push(`The webhook body: ${wrapUntrusted("webhook", run.triggerPayload.body)}`);
  }
  if (typeof run.config.handoffPath === "string")
    lines.push(`Latest handoff file: ${run.config.handoffPath}`);
  const calls = ctx.events
    .list(run.id)
    .filter((e) => e.kind === "tool_call")
    .map(
      (e) =>
        `- attempt ${e.attempt ?? 1}: ${String(e.payload.toolName ?? "unknown")} (${String(e.payload.riskLevel ?? "L2")})`,
    );
  if (calls.length > 0) {
    lines.push(`Tool calls the earlier attempts made (${calls.length}), with their tiers:`);
    lines.push(...calls.slice(-50));
  }
  const interrupted = run.config[PLATFORM_CONFIG.interrupted];
  if (interrupted && typeof interrupted === "object")
    lines.push(interruptedCallNotice(interrupted as InterruptedToolCall));
  return lines.join("\n");
}

/**
 * Decision 7: a run a platform interruption ended says so, once, in its thread (a threadless
 * run's notice goes to its bot's private chat, as approvals do). Routing-inert: it wakes nobody;
 * the delegation notice that follows wakes the delegator.
 */
export function announcePlatformFailure(
  ctx: GatewayContext,
  run: RunRecord,
  published: GatewayEvent[],
): void {
  if (run.error !== RUN_ERROR_GATEWAY_RESTARTED) return;
  const threadId = ctx.broker.noticeThread(run).threadId;
  if (!threadId) return;
  const bot = ctx.bots.mustGetIncludingArchived(run.botId);
  const posted = ctx.router.postSystem(
    threadId,
    `${bot.name}'s run was stopped by a platform restart and could not be continued (${RUN_ERROR_GATEWAY_RESTARTED}).`,
    [],
    { inert: true },
  );
  published.push({ type: "thread_message", threadId, message: posted.message });
}

/** The approval a drained run's live wait was on, when it is still pending. */
export function pendingDrainApproval(ctx: GatewayContext, run: RunRecord): ApprovalId | undefined {
  const approvals = [
    ...new Set([
      ...(run.resumePayload?.approvalId ? [run.resumePayload.approvalId] : []),
      ...(run.resumePayload?.approvalIds ?? []),
    ]),
  ]
    .map((id) => ctx.approvals.get(id as ApprovalId))
    .filter((approval) => approval?.runId === run.id);
  if (approvals.some((approval) => approval?.decision !== undefined)) return undefined;
  return approvals.find((approval) => !approval?.decision)?.id;
}

/**
 * Decision 10: a run records the SDK it started on, from the CLI build the SDK reports at init on
 * its first attempt. A later attempt on another build is a resume across an SDK change, logged on
 * the run so a release's fresh-session fallbacks can be counted.
 */
export function noteSdkVersion(
  ctx: GatewayContext,
  run: RunRecord,
  version: string,
  attempt: number,
): void {
  const recorded = run.config[PLATFORM_CONFIG.sdkVersion];
  if (typeof recorded !== "string") {
    ctx.runs.setConfig(run.id, { [PLATFORM_CONFIG.sdkVersion]: version });
    return;
  }
  if (recorded === version) return;
  ctx.events.append({
    runId: run.id,
    attempt,
    kind: "log",
    payload: {
      source: PLATFORM_LOG_SOURCE,
      op: "sdk_version_changed",
      from: recorded,
      to: version,
    },
  });
}
