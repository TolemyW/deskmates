// One driver per cheap-model job kind (protocol of 2026-10-17, comparison C): seed what the job
// reads, start the job through the Gateway's own entry point, wait for its run, and read back what
// the grader needs. T3/T4 support: used only by `cheap-model-campaign.acceptance.test.ts`.
//
// Isolation between tasks: kinds that read a whole workspace's shared activity or roster
// (memory_recheck, round_triage) get a fresh workspace per task, destroyed after it; the memory
// kinds in the stack's own workspace forget every live entry before they seed.

import type {
  BotDefinition,
  BotId,
  RunEvent,
  RunId,
  Thread,
  WorkspaceId,
} from "@deskmates/contracts";
import { isTerminal } from "@deskmates/contracts";
import { setCanonicalSoul } from "../../acceptance/support/canonical-soul.js";
import {
  type GroupTarget,
  createGroupBot,
  createGroupThread,
  postGroupMessage,
} from "../../acceptance/support/m2-group.js";
import { POLL_MS, runEvents, waitForRun } from "../../acceptance/support/runs.js";
import {
  type ExtraWorkspace,
  type Stack,
  addWorkspace,
} from "../../acceptance/support/start-stack.js";
import { accounting } from "../campaign/stack.js";
import type { CheapObservation } from "./grade.js";
import type { CheapTask } from "./task-set.js";

const DAY = 86_400_000;
const JOB_TIMEOUT_MS = 5 * 60_000;
const NEUTRAL_SOUL = (name: string) =>
  `# ${name}\n\nYou help the warehouse team. Keep replies short. Use no tools unless asked.\n`;

type Ctx = Stack["app"]["deskmates"]["ctx"];

export interface DriverResult extends Omit<CheapObservation, "taskId" | "arm" | "repeat"> {}

function ctxOf(stack: Stack): Ctx {
  return stack.app.deskmates.ctx;
}

function kick(stack: Stack, runId: string): void {
  const ctx = ctxOf(stack);
  ctx.bus.publish({ type: "run_status", run: ctx.runs.mustGet(runId as RunId) });
  stack.app.deskmates.scheduler.kick();
}

/** Wait for the job run and collect what every kind records. */
async function finish(stack: Stack, runId: string): Promise<DriverResult> {
  await waitForRun(stack, runId, JOB_TIMEOUT_MS);
  const run = ctxOf(stack).runs.mustGet(runId as RunId);
  const usage = await accounting(stack, runId);
  return {
    runId,
    status: run.status,
    reply: run.summary?.reply ?? null,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: usage.costUsd,
    wallMs: usage.wallMs,
    servedModels: usage.servedModels,
  };
}

/** Forget every live entry of a workspace, so the next memory task starts from nothing. */
async function forgetAll(stack: Stack, workspaceId: WorkspaceId): Promise<void> {
  const rows = ctxOf(stack)
    .db.prepare("SELECT id FROM memory_entries WHERE workspace_id = ? AND tombstoned = 0")
    .all(workspaceId) as { id: string }[];
  for (const row of rows) {
    const res = await stack.api("POST", `/api/memory/entries/${row.id}/forget`, {});
    if (res.status !== 200) throw new Error(`harness: forget ${row.id}: ${res.status}`);
  }
}

function insertNote(
  stack: Stack,
  workspaceId: WorkspaceId,
  body: string,
  observedAt: number,
  over: {
    kind?: "note" | "candidate" | "episode";
    scope?: "workspace" | "bot";
    botId?: BotId;
  } = {},
): string {
  return ctxOf(stack).memory.entries.insert({
    workspaceId,
    scope: over.scope ?? "workspace",
    kind: over.kind ?? "note",
    ...(over.botId ? { botId: over.botId } : {}),
    body,
    authority: "fact",
    trust: "trusted",
    sourceKind: over.kind === undefined || over.kind === "note" ? "human" : "bot_self",
    by: "fixture:cheap-model-eval",
    observedAt: new Date(observedAt).toISOString(),
  }).id;
}

/** A fresh workspace for one task; `retire` destroys its container straight after the task. */
async function freshWorkspace(stack: Stack, label: string): Promise<ExtraWorkspace> {
  const extra = await addWorkspace(stack, { label, egressAllowlist: [] });
  const res = await stack.api("PUT", `/api/workspaces/${extra.workspace.id}/memory/maintenance`, {
    recheckDailyLimit: 1000,
    organizeDaily: false,
  });
  if (res.status !== 200) throw new Error(`harness: maintenance settings: ${res.status}`);
  return extra;
}

async function retire(stack: Stack, extra: ExtraWorkspace): Promise<void> {
  await stack.docker.destroy(extra.handle);
  // stop-stack still removes the volumes; the container is gone already.
  stack.extraWorkspaces = stack.extraWorkspaces.filter((x) => x !== extra);
  stack.volumes.push(...extra.volumes);
}

export interface CheapDrivers {
  /** Bots the SOUL-proposal cases edit, by name, in the stack's own workspace. */
  soulBots: Map<string, BotDefinition>;
}

/** One-time setup in the stack's workspace: automatic memory jobs off, the SOUL bots created. */
export async function prepareDrivers(
  stack: Stack,
  tasks: readonly CheapTask[],
): Promise<CheapDrivers> {
  const res = await stack.api("PUT", `/api/workspaces/${stack.workspace.id}/memory/maintenance`, {
    recheckDailyLimit: 0,
    organizeDaily: false,
  });
  if (res.status !== 200) throw new Error(`harness: maintenance settings: ${res.status}`);
  const soulBots = new Map<string, BotDefinition>();
  for (const t of tasks) {
    const c = t.case;
    if (c.kind !== "soul_proposal" || soulBots.has(c.input.botName)) continue;
    soulBots.set(
      c.input.botName,
      await createGroupBot(stack, {
        name: c.input.botName,
        role: c.input.role,
        soul: c.input.baseBody,
      }),
    );
  }
  return { soulBots };
}

function triagePlan(
  events: readonly RunEvent[],
  names: Map<string, string>,
): { assigned: string[]; closer: string } | null {
  const log = events.find((e) => e.kind === "log" && e.payload.source === "round_triage");
  if (!log || log.payload.outcome !== "planned") return null;
  const assigned = Array.isArray(log.payload.assigned) ? (log.payload.assigned as string[]) : [];
  return {
    assigned: assigned.map((id) => names.get(id) ?? id),
    closer: names.get(String(log.payload.closerBotId)) ?? String(log.payload.closerBotId),
  };
}

/** Cancel every run a triage dispatched and return what they cost (unknown → null). */
async function stopWorkers(
  stack: Stack,
  thread: Thread,
  triageRunId: string,
): Promise<number | null> {
  const ctx = ctxOf(stack);
  const deadline = Date.now() + 10_000;
  // The router dispatches when the triage run ends; give it a moment to create the workers.
  while (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  const workers = ctx.runs.list({ threadId: thread.id }).filter((r) => r.id !== triageRunId);
  for (const w of workers)
    if (!isTerminal(w.status)) stack.app.deskmates.scheduler.cancel(w.id, "evaluation:triage-only");
  let total = 0;
  for (const w of workers) {
    await waitForRun(stack, w.id, 120_000);
    const cost = (await accounting(stack, w.id)).costUsd;
    if (cost === null) return null;
    total += cost;
  }
  return total;
}

export async function runCheapTask(
  stack: Stack,
  drivers: CheapDrivers,
  task: CheapTask,
  label: string,
  /** Called with the fixture key → Gateway id map before the job starts (the dry run's script). */
  onSeeded: (ids: Record<string, string>) => void = () => {},
): Promise<DriverResult> {
  const ctx = ctxOf(stack);
  const c = task.case;
  const now = Date.now();
  switch (c.kind) {
    case "activity_summary": {
      // A finished run whose outcome is the case; the store queues its summary job (ADR-0033).
      const source = ctx.runs.create({
        botId: stack.bot.id,
        lane: "background",
        triggerKind: "cron",
        triggerRef: `evaluation-summary-source:${label}`,
        triggerPayload: { prompt: c.input.request },
        config: ctx.runConfig(),
      });
      ctx.runs.transition(source.id, "running");
      const ended = ctx.runs.transition(source.id, c.input.status, {
        summary: {
          done: c.input.done,
          filesChanged: [],
          sitesVisited: [],
          pendingApprovals: [],
          memorySuggestions: [],
          reply: c.input.reply,
        },
        ...(c.input.error ? { error: c.input.error } : {}),
      });
      const job = ctx.activitySummaries.onRunStatus(ended);
      if (!job) throw new Error(`harness: no summary job for ${task.taskId}`);
      kick(stack, job.id);
      const result = await finish(stack, job.id);
      const summary = ctx.activitySummaries.forRuns([ctx.runs.mustGet(source.id)]).get(source.id);
      return { ...result, summaryText: summary?.text ?? null };
    }
    case "memory_consolidation": {
      await forgetAll(stack, stack.workspace.id);
      c.input.sources.forEach((s, i) =>
        insertNote(stack, stack.workspace.id, s.body, now - 3 * DAY + i * 60_000, {
          kind: s.kind,
          ...(s.kind === "candidate" ? { scope: "bot" as const, botId: stack.bot.id } : {}),
        }),
      );
      const res = await stack.api<{ run: { id: string } }>(
        "POST",
        `/api/bots/${stack.bot.id}/memory/consolidate`,
        {},
      );
      if (res.status !== 202) throw new Error(`harness: consolidate: ${res.status}`);
      const result = await finish(stack, res.json.run.id);
      const learned = (ctx.runs.mustGet(res.json.run.id as RunId).summary?.learned ?? []).map(
        (l) => l.body,
      );
      const probes = [];
      for (const p of c.expect.probes) {
        const found = await stack.api<{ entries: { body: string }[] }>(
          "GET",
          `/api/workspaces/${stack.workspace.id}/memory/search?q=${encodeURIComponent(p.query)}`,
        );
        probes.push({ query: p.query, hits: (found.json.entries ?? []).map((e) => e.body) });
      }
      return { ...result, learned, probes };
    }
    case "memory_organize": {
      await forgetAll(stack, stack.workspace.id);
      const ids: Record<string, string> = {};
      c.input.notes.forEach((n, i) => {
        ids[n.key] = insertNote(stack, stack.workspace.id, n.body, now - DAY + i * 1000);
      });
      onSeeded(ids);
      const res = await stack.api<{ job: { runId: string; noteCount: number } }>(
        "POST",
        `/api/workspaces/${stack.workspace.id}/memory/organize`,
        {},
      );
      if (res.status !== 202 || res.json.job.noteCount !== c.input.notes.length)
        throw new Error(`harness: organize job for ${task.taskId}: ${res.status}`);
      return { ...(await finish(stack, res.json.job.runId)), ids };
    }
    case "memory_recheck": {
      const extra = await freshWorkspace(stack, `rc-${label}`);
      try {
        const target: GroupTarget = { workspace: extra.workspace, handle: extra.handle };
        const keeper = await createGroupBot(
          stack,
          { name: "keeper", role: "keeps the notes", soul: NEUTRAL_SOUL("keeper") },
          target,
        );
        const helper = await createGroupBot(
          stack,
          { name: "helper", role: "works the floor", soul: NEUTRAL_SOUL("helper") },
          target,
        );
        const append = (thread: Thread, author: "human" | "bot", body: string) =>
          ctx.messages.append({
            threadId: thread.id,
            authorKind: author,
            authorId: author === "bot" ? helper.id : "evaluation-operator",
            body,
          });
        if (c.input.fillerActivity?.length) {
          const filler = await createGroupThread(stack, [keeper, helper], "Floor chatter", target);
          for (const m of c.input.fillerActivity) append(filler, "human", m);
        }
        const thread = await createGroupThread(
          stack,
          [keeper, helper],
          "Warehouse updates",
          target,
        );
        for (const m of c.input.activity) append(thread, m.author, m.body);
        const ids: Record<string, string> = {};
        c.input.notes.forEach((n, i) => {
          ids[n.key] = insertNote(stack, extra.workspace.id, n.body, now - 400 * DAY + i * 60_000);
        });
        onSeeded(ids);
        ctx.memory.freshness.sweep(extra.workspace.id);
        const queued = ctx.modelJobs.recheck.request(extra.workspace.id);
        const latest = ctx.modelJobs.recheck.latest(extra.workspace.id);
        const runId = queued?.run.id ?? (latest?.status === "pending" ? latest.runId : undefined);
        if (!runId) throw new Error(`harness: no recheck job for ${task.taskId}`);
        const input = ctx.runs.mustGet(runId as RunId).config.memoryRecheckInput;
        if (!Array.isArray(input) || input.length !== c.input.notes.length)
          throw new Error(`harness: recheck job of ${task.taskId} does not hold every note`);
        kick(stack, runId);
        return { ...(await finish(stack, runId)), ids };
      } finally {
        await retire(stack, extra);
      }
    }
    case "round_triage": {
      const extra = await freshWorkspace(stack, `rt-${label}`);
      try {
        const target: GroupTarget = { workspace: extra.workspace, handle: extra.handle };
        const bots: BotDefinition[] = [];
        for (const m of c.input.roster)
          bots.push(
            await createGroupBot(
              stack,
              { name: m.name, role: m.role, soul: NEUTRAL_SOUL(m.name) },
              target,
            ),
          );
        const names = new Map(bots.map((b) => [b.id as string, b.name]));
        const thread = await createGroupThread(stack, bots, "Team requests", target);
        const owner = bots[c.input.roster.findIndex((m) => m.owner)];
        if (owner) ctx.threads.setOwner(thread.id, owner.id);
        const posted = await postGroupMessage(stack, thread, c.input.request);
        const row = ctx.db
          .prepare("SELECT id FROM runs WHERE trigger_ref = ?")
          .get(`round_triage:${posted.message.id}`) as { id: string } | undefined;
        if (!row)
          throw new Error(
            `harness: no triage run for ${task.taskId} (is DESKMATES_GROUP_ROUTING round-v1?)`,
          );
        const result = await finish(stack, row.id);
        const plan = triagePlan(await runEvents(stack, row.id), names);
        return { ...result, plan, leakUsd: await stopWorkers(stack, thread, row.id) };
      } finally {
        await retire(stack, extra);
      }
    }
    case "soul_proposal": {
      const bot = drivers.soulBots.get(c.input.botName);
      if (!bot) throw new Error(`harness: no bot ${c.input.botName}`);
      await setCanonicalSoul(stack.api, bot.id, c.input.baseBody, bot.name);
      const res = await stack.api<{ proposal: { id: string; runId: string | null } }>(
        "POST",
        `/api/bots/${bot.id}/soul-proposals`,
        { instruction: c.input.instruction },
      );
      if (res.status !== 202 || !res.json.proposal.runId)
        throw new Error(`harness: SOUL proposal for ${task.taskId}: ${res.status}`);
      const result = await finish(stack, res.json.proposal.runId);
      const read = await stack.api<{
        proposal: { status: string; proposedBody: string | null; error: string | null };
      }>("GET", `/api/bots/${bot.id}/soul-proposals/${res.json.proposal.id}`);
      const p = read.json.proposal;
      return {
        ...result,
        proposal: { status: p.status, proposedBody: p.proposedBody, error: p.error },
      };
    }
  }
}
