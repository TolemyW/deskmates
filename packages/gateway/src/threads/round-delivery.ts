// What a wake under `round-v1` is told beyond the roster (ADR-0005 amendment 6, proposed): the
// plan of the round it works on or closes (decisions 47, 48), and what its own previous final
// reply in the thread addressed and missed (decision 50). Gateway facts, rendered by the sidecar
// in the first user turn; they confer no authority on bot content.

import {
  type BotId,
  type PostedMessageRouting,
  type RoundAssignmentOutcome,
  type RunStatus,
  type ThreadMessage,
  type ThreadRoundBrief,
  mentionDiagnostics,
} from "@deskmates/contracts";
import type { GatewayContext } from "../context.js";
import type { RunRecord } from "../ledger/runs.js";
import { RoundPlanStore } from "./round-plans.js";

type Ctx = Pick<GatewayContext, "db" | "messages" | "threads" | "runs" | "events">;

function outcomeOf(status: RunStatus | undefined, posted: number): RoundAssignmentOutcome {
  if (status === "failed" || status === "cancelled" || status === "stopped") return status;
  return posted > 0 ? "replied" : "silent";
}

/** The plan of the round this run works on or closes, or nothing when it serves none. */
export function roundBrief(
  ctx: Ctx,
  run: RunRecord,
  name: (botId: BotId) => string,
): ThreadRoundBrief | undefined {
  const plans = new RoundPlanStore(ctx.db);
  const found = plans.forDelivery(run.id);
  if (!found) return undefined;
  const { plan, phase } = found;
  const request = ctx.messages.get(plan.messageId);
  const closer = plan.closerBotId ?? plan.assignments[0]?.botId;
  if (!request || !closer) return undefined;
  const outcomes =
    phase === "close"
      ? plans.assignedRuns(plan).map((assigned) => {
          const seqs = assigned.runId
            ? ctx.messages
                .postedByRun(assigned.runId)
                .filter(
                  (m) =>
                    m.authorKind === "bot" &&
                    m.threadId === request.threadId &&
                    m.seq > request.seq,
                )
                .map((m) => m.seq)
            : [];
          return {
            name: name(assigned.botId),
            outcome: outcomeOf(assigned.status, seqs.length),
            seqs,
          };
        })
      : undefined;
  return {
    messageSeq: request.seq,
    phase,
    assignments: plan.assignments.map((a) => ({
      name: name(a.botId),
      task: a.task,
      ...(a.botId === run.botId ? { you: true as const } : {}),
    })),
    closer: name(closer),
    ...(closer === run.botId ? { youClose: true as const } : {}),
    ...(outcomes ? { outcomes } : {}),
  };
}

function isPostedRouting(value: unknown): value is PostedMessageRouting {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.seq === "number" &&
    Array.isArray(v.addressed) &&
    typeof v.everyone === "boolean" &&
    Array.isArray(v.unknown) &&
    Array.isArray(v.spaced)
  );
}

/**
 * Decision 50: when this bot's previous ordinary run in the thread recorded that its final reply
 * missed someone, those facts; each record is delivered to the next wake only.
 */
export function lastReplyRouting(ctx: Ctx, run: RunRecord): PostedMessageRouting | undefined {
  if (!run.threadId) return undefined;
  const row = ctx.db
    .prepare(
      `SELECT config_json FROM runs
       WHERE bot_id = ? AND thread_id = ? AND id <> ? AND run_type IS NULL
         AND status IN ('succeeded', 'silent', 'failed', 'cancelled', 'stopped')
       ORDER BY coalesce(finished_at, created_at) DESC, rowid DESC LIMIT 1`,
    )
    .get(run.botId, run.threadId, run.id) as { config_json: string } | undefined;
  if (!row) return undefined;
  const recorded = (JSON.parse(row.config_json) as Record<string, unknown>).finalReplyRouting;
  return isPostedRouting(recorded) ? recorded : undefined;
}

/**
 * Decision 50: a final reply under `round-v1` that writes `@names` no member has is recorded on
 * its run, for the bot's next wake in the thread, and in the ledger. Nothing about who is woken
 * changes.
 */
export function recordFinalReplyRouting(ctx: Ctx, run: RunRecord, message: ThreadMessage): void {
  if (run.config.groupRouting !== "round-v1") return;
  const members = ctx.threads.members(message.threadId);
  const { unknown } = mentionDiagnostics(message.body, members, run.botId, { spaced: true });
  if (unknown.length === 0) return;
  const names = new Map(members.map((member) => [member.botId as string, member.name]));
  const routing: PostedMessageRouting = {
    seq: message.seq,
    addressed: message.mentions.flatMap((mention) =>
      mention.kind === "bot" ? [names.get(mention.botId) ?? mention.botId] : [],
    ),
    everyone: message.mentions.some((mention) => mention.kind === "everyone"),
    unknown,
    spaced: [],
  };
  ctx.runs.setConfig(run.id, { finalReplyRouting: routing });
  ctx.events.append({
    runId: run.id,
    kind: "log",
    payload: { source: "final_reply_routing", messageId: message.id, unknown },
  });
}

/** Both facts of a `round-v1` wake, each present only when there is something to say. */
export function roundFacts(
  ctx: Ctx,
  run: RunRecord,
  name: (botId: BotId) => string,
): { round?: ThreadRoundBrief; lastReply?: PostedMessageRouting } {
  const round = roundBrief(ctx, run, name);
  const lastReply = lastReplyRouting(ctx, run);
  return { ...(round ? { round } : {}), ...(lastReply ? { lastReply } : {}) };
}
