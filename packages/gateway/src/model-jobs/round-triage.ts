// Round triage (ADR-0005 amendment 6, decision 45; proposed, `round-v1` only). A human request to
// a group is planned by a cheap-model job: which members work, one line of what each does, and
// which member closes. The job is a recorded run (row first) of the thread's owner, or of its
// first member, with no tools, session or workspace context; the Gateway validates its answer
// against the current members and the router decides who wakes. The job decides nothing itself.

import type {
  BotDefinition,
  BotId,
  MessageId,
  ModelJobRequest,
  RunEnded,
  Thread,
  ThreadMessage,
} from "@deskmates/contracts";
import type { BotStore } from "../bots/bots.js";
import type { GatewayContext } from "../context.js";
import type { GatewayDb } from "../db/open.js";
import type { RunRecord, RunStore } from "../ledger/runs.js";
import { modelsForJob } from "../scheduler/job-models.js";
import { RoundPlanStore } from "../threads/round-plans.js";
import type { NamedMember } from "../threads/threads.js";

export const ROUND_TRIAGE = "round_triage";

/** Decision 45: a task is one line of at most this many characters. */
export const TRIAGE_TASK_MAX_CHARS = 200;

/** How much of the request the job reads; the transcript keeps the whole message. */
export const TRIAGE_REQUEST_MAX_CHARS = 8000;

/** Whether a run is a triage job: it never waits for its bot's lane (decision 45). */
export function isRoundTriageRun(run: { config: Record<string, unknown> }): boolean {
  return run.config.runType === ROUND_TRIAGE;
}

/** What the router asks for when a request is triaged; undefined when no job can be made. */
export interface RoundTriageRequester {
  request(input: {
    thread: Thread;
    message: ThreadMessage;
    members: readonly NamedMember[];
  }): RunRecord | undefined;
}

export function roundTriageRequester(deps: {
  runs: RunStore;
  bots: BotStore;
  runConfig: () => Record<string, unknown>;
  cheapModel: () => string;
}): RoundTriageRequester {
  return {
    request({ thread, message, members }) {
      const owner = members.find((m) => m.botId === thread.ownerBotId);
      const runner = owner ?? members[0];
      if (!runner) return undefined;
      const bot = deps.bots.get(runner.botId);
      if (!bot) return undefined;
      return deps.runs.create({
        botId: runner.botId,
        threadId: thread.id,
        lane: "background",
        triggerKind: "cron",
        triggerRef: `${ROUND_TRIAGE}:${message.id}`,
        triggerPayload: { prompt: "" },
        config: {
          ...deps.runConfig(),
          runType: ROUND_TRIAGE,
          roundMessageId: message.id,
          ...modelsForJob(ROUND_TRIAGE, bot.cheapModel ?? deps.cheapModel()),
          fallbackModel: null,
          maxTurns: 1,
          roundTriageVersion: 1,
        },
      });
    },
  };
}

export type TriagePlan =
  | { ok: true; assignments: { botId: BotId; task: string }[]; closerBotId: BotId }
  | { ok: false; error: string };

/** One line, trimmed and bounded. */
function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > TRIAGE_TASK_MAX_CHARS
    ? `${line.slice(0, TRIAGE_TASK_MAX_CHARS - 1)}…`
    : line;
}

function nameOf(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim().replace(/^@\s*/, "").toLowerCase() : undefined;
}

/**
 * Decision 45: the job's answer, validated against the current members. Names that are no
 * member, repeated members and empty tasks are dropped; a closer that is not a member becomes the
 * owner when it is assigned, else the first assignee. No assignment left is a failure.
 */
export function parseTriagePlan(
  reply: string,
  members: ReadonlyArray<{ botId: BotId; name: string }>,
  ownerBotId?: BotId,
): TriagePlan {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false, error: "triage returned no JSON object" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return { ok: false, error: "triage returned invalid JSON" };
  }
  if (!parsed || typeof parsed !== "object")
    return { ok: false, error: "triage returned no JSON object" };
  const value = parsed as { assignments?: unknown; closer?: unknown };
  const byName = new Map(members.map((m) => [m.name.toLowerCase(), m.botId]));
  const assignments: { botId: BotId; task: string }[] = [];
  for (const item of Array.isArray(value.assignments) ? value.assignments : []) {
    if (!item || typeof item !== "object") continue;
    const entry = item as { member?: unknown; name?: unknown; task?: unknown };
    const botId = byName.get(nameOf(entry.member ?? entry.name) ?? "");
    const task = typeof entry.task === "string" ? oneLine(entry.task) : "";
    if (!botId || !task || assignments.some((a) => a.botId === botId)) continue;
    assignments.push({ botId, task });
  }
  const first = assignments[0];
  if (!first) return { ok: false, error: "triage assigned no member of the thread" };
  const named = byName.get(nameOf(value.closer) ?? "");
  const closerBotId =
    named ??
    (ownerBotId && assignments.some((a) => a.botId === ownerBotId) ? ownerBotId : first.botId);
  return { ok: true, assignments, closerBotId };
}

export class RoundTriage {
  constructor(private readonly ctx: GatewayContext) {}

  private plans(): RoundPlanStore {
    return new RoundPlanStore(this.ctx.db);
  }

  private request(run: RunRecord): ThreadMessage | undefined {
    const id = run.config.roundMessageId;
    const message = typeof id === "string" ? this.ctx.messages.get(id as MessageId) : undefined;
    return message && message.threadId === run.threadId ? message : undefined;
  }

  /** The job the sidecar runs, built at start from the current roster. */
  job(run: RunRecord, _bot: BotDefinition): ModelJobRequest | undefined {
    const message = this.request(run);
    if (!message) return undefined;
    const thread = this.ctx.threads.mustGet(message.threadId);
    const roles = new Map(this.ctx.bots.list(thread.workspaceId).map((b) => [b.id, b.role]));
    return {
      kind: "round_triage",
      roster: this.ctx.threads.members(thread.id).map((m) => ({
        name: m.name,
        role: roles.get(m.botId) ?? "",
        ...(m.botId === thread.ownerBotId ? { owner: true as const } : {}),
      })),
      everyone: message.mentions.some((m) => m.kind === "everyone"),
      request: message.body.slice(0, TRIAGE_REQUEST_MAX_CHARS),
    };
  }

  /**
   * Store the validated plan for the router to dispatch when the run ends (`ThreadRouter.
   * runEnded`). A failed or invalid answer stores nothing, which is the router's cue to fall back.
   */
  complete(run: RunRecord, ended: RunEnded): "succeeded" | "failed" {
    const reply = ended.outcome === "completed" ? (ended.summary?.reply ?? "") : "";
    const message = this.request(run);
    const plans = this.plans();
    const plan = message ? plans.get(message.id) : undefined;
    if (!reply || !message || !plan || plan.triageRunId !== run.id || plan.phase !== "triage")
      return "failed";
    const thread = this.ctx.threads.mustGet(message.threadId);
    const result = parseTriagePlan(reply, this.ctx.threads.members(thread.id), thread.ownerBotId);
    if (!result.ok) {
      this.ctx.events.append({
        runId: run.id,
        kind: "log",
        payload: { source: ROUND_TRIAGE, outcome: "invalid", error: result.error },
      });
      return "failed";
    }
    plans.storeAssignments(message.id, result.assignments, result.closerBotId);
    this.ctx.events.append({
      runId: run.id,
      kind: "log",
      payload: {
        source: ROUND_TRIAGE,
        outcome: "planned",
        messageId: message.id,
        assigned: result.assignments.map((a) => a.botId),
        closerBotId: result.closerBotId,
      },
    });
    return "succeeded";
  }
}

/** The router's round options (amendment 6): the plan store and the triage requester. */
export function roundRouting(deps: {
  db: GatewayDb;
  runs: RunStore;
  bots: BotStore;
  runConfig: () => Record<string, unknown>;
  cheapModel: () => string;
}): { roundPlans: RoundPlanStore; triage: RoundTriageRequester } {
  return { roundPlans: new RoundPlanStore(deps.db), triage: roundTriageRequester(deps) };
}
