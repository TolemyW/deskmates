// Automatic model recheck of flagged notes (ADR-0011 amendment 4, A28, owner ruling 2026-10-14).
// The periodic pass queues one cheap-model job per workspace for flags a model may answer; the
// sidecar asks the model, and the Gateway validates each verdict deterministically. `still_true`
// renews the note with a `confirm` version by `model:<run>`; `possibly_stale` waits for a person;
// `unclear` waits a day. Nothing here calls a model, raises trust, edits a body or writes a rule.

import {
  DeskmatesError,
  MEMORY_RECHECK_MAX_NOTES,
  MEMORY_RECHECK_REASONS,
  type MemoryRecheckJob,
  type ModelJobRequest,
  type RunEnded,
  type ThreadMessage,
  type WorkspaceId,
  decidedByModelRun,
  isTerminal,
  parseMemoryRecheckReply,
} from "@deskmates/contracts";
import type { GatewayContext } from "../context.js";
import { newId } from "../db/ids.js";
import type { RunRecord } from "../ledger/runs.js";
import { modelsForJob } from "../scheduler/job-models.js";
import { readMaintenanceSettings } from "./maintenance-settings.js";
import {
  type RecheckSnapshot,
  evidenceHash,
  hasRenewalEvidence,
  recheckSnapshot,
} from "./recheck-evidence.js";
import { sanitizeMemoryBody } from "./sanitize.js";

export const MEMORY_RECHECK = "memory_recheck";

const DAY_MS = 86_400_000;

/** How much recent shared activity one job reads (A28); recorded on every job's run. */
export const RECHECK_ACTIVITY_LIMITS = {
  days: 7,
  threads: 10,
  messagesPerThread: 15,
  messageChars: 500,
  tasks: 15,
  taskChars: 300,
  total: 24_000,
} as const;

interface JobRow {
  id: string;
  workspace_id: string;
  run_id: string;
  status: MemoryRecheckJob["status"];
  note_count: number;
  still_true: number;
  possibly_stale: number;
  unclear: number;
  dropped: number;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

function jobView(row: JobRow): MemoryRecheckJob {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    status: row.status,
    runId: row.run_id,
    noteCount: row.note_count,
    stillTrue: row.still_true,
    possiblyStale: row.possibly_stale,
    unclear: row.unclear,
    dropped: row.dropped,
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.created_at,
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
  };
}

/** The (flag, entry, version) triples a job was given, from its run config. */
function inputOf(run: RunRecord): { flagId: string; entryId: string; version: number }[] {
  const raw = run.config.memoryRecheckInput;
  const out: { flagId: string; entryId: string; version: number }[] = [];
  for (const t of Array.isArray(raw) ? raw : [])
    if (
      Array.isArray(t) &&
      typeof t[0] === "string" &&
      typeof t[1] === "string" &&
      typeof t[2] === "number"
    )
      out.push({ flagId: t[0], entryId: t[1], version: t[2] });
  return out;
}

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

export class MemoryRecheck {
  constructor(private readonly ctx: GatewayContext) {}

  private get db() {
    return this.ctx.db;
  }

  latest(workspaceId: WorkspaceId): MemoryRecheckJob | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM memory_recheck_jobs WHERE workspace_id = ?
          ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(workspaceId) as JobRow | undefined;
    return row ? jobView(row) : undefined;
  }

  /** Notes sent to recheck jobs of this workspace created in the 24 hours before `now`. */
  usedToday(workspaceId: WorkspaceId, now: Date): number {
    const since = new Date(now.getTime() - DAY_MS).toISOString();
    return (
      this.db
        .prepare(
          `SELECT COALESCE(SUM(note_count), 0) AS n FROM memory_recheck_jobs
            WHERE workspace_id = ? AND created_at > ?`,
        )
        .get(workspaceId, since) as { n: number }
    ).n;
  }

  /**
   * A28: open flags the model may answer now, never-checked first, then oldest. Excludes
   * `replaced_trusted`, a `possibly_stale` verdict on the current version, and an `unclear`
   * verdict on the current version less than a day old.
   */
  eligible(
    workspaceId: WorkspaceId,
    limit: number,
    now: Date,
  ): { flagId: string; entryId: string; version: number }[] {
    const reasons = MEMORY_RECHECK_REASONS.map(() => "?").join(", ");
    const dayAgo = new Date(now.getTime() - DAY_MS).toISOString();
    const rows = this.db
      .prepare(
        `SELECT r.id AS flag_id, e.id AS entry_id, e.version AS version
           FROM memory_revalidations r JOIN memory_entries e ON e.id = r.entry_id
          WHERE r.workspace_id = ? AND r.status = 'open' AND r.reason IN (${reasons})
            AND e.workspace_id = r.workspace_id AND e.tombstoned = 0 AND e.invalid_at IS NULL
            AND e.episode_id IS NULL AND e.kind = 'note' AND e.scope IN ('workspace', 'bot')
            AND (r.model_verdict IS NULL OR r.model_entry_version IS NOT e.version
                 OR (r.model_verdict = 'unclear' AND r.model_checked_at <= ?))
            AND NOT EXISTS (
              SELECT 1 FROM memory_recheck_jobs j JOIN runs x ON x.id = j.run_id,
                json_each(x.config_json, '$.memoryRecheckInput') i
              WHERE j.workspace_id = r.workspace_id AND j.created_at > ?
                AND json_extract(i.value, '$[1]') = e.id
                AND json_extract(i.value, '$[2]') = e.version)
          ORDER BY (r.model_verdict IS NOT NULL), r.flagged_at, r.id LIMIT ?`,
      )
      .all(workspaceId, ...MEMORY_RECHECK_REASONS, dayAgo, dayAgo, limit) as {
      flag_id: string;
      entry_id: string;
      version: number;
    }[];
    return rows.map((r) => ({ flagId: r.flag_id, entryId: r.entry_id, version: r.version }));
  }

  /** A pending job whose run already ended without settling it (it never started) is failed. */
  private settleOrphan(workspaceId: WorkspaceId, now: Date): JobRow | undefined {
    const pending = this.db
      .prepare("SELECT * FROM memory_recheck_jobs WHERE workspace_id = ? AND status = 'pending'")
      .get(workspaceId) as JobRow | undefined;
    if (!pending) return undefined;
    const run = this.ctx.runs.get(pending.run_id as RunRecord["id"]);
    if (run && !isTerminal(run.status)) return pending;
    this.db
      .prepare(
        `UPDATE memory_recheck_jobs SET status = 'failed', error = ?, finished_at = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run("The job's run ended without a result", now.toISOString(), pending.id);
    return undefined;
  }

  /**
   * A28: queue one job when the workspace has eligible flags, none pending, and room in its daily
   * limit. Returns nothing when any condition fails; never throws for a quiet workspace.
   */
  request(
    workspaceId: WorkspaceId,
    now: Date = new Date(),
  ): { job: MemoryRecheckJob; run: RunRecord } | undefined {
    return this.db.transaction(() => {
      const limit = readMaintenanceSettings(this.db, workspaceId).recheckDailyLimit;
      if (limit <= 0) return undefined;
      if (this.settleOrphan(workspaceId, now)) return undefined;
      const room = Math.min(MEMORY_RECHECK_MAX_NOTES, limit - this.usedToday(workspaceId, now));
      if (room <= 0) return undefined;
      const input = this.eligible(workspaceId, room, now);
      if (input.length === 0) return undefined;
      // The job is attributed to the workspace's oldest active bot; it reads no bot context.
      const bot = this.ctx.bots.list(workspaceId)[0];
      if (!bot) return undefined;
      const id = newId("mrck");
      const run = this.ctx.runs.create({
        botId: bot.id,
        lane: "background",
        triggerKind: "model_job",
        triggerRef: `${MEMORY_RECHECK}:${id}`,
        triggerPayload: { prompt: "" },
        config: {
          ...this.ctx.runConfig(),
          runType: MEMORY_RECHECK,
          memoryRecheckJobId: id,
          memoryRecheckVersion: 2,
          memoryRecheckSnapshot: this.snapshot(workspaceId, now),
          memoryRecheckInput: input.map((n) => [n.flagId, n.entryId, n.version]),
          memoryRecheckBounds: {
            maxNotes: MEMORY_RECHECK_MAX_NOTES,
            dailyLimit: limit,
            activity: { ...RECHECK_ACTIVITY_LIMITS },
          },
          ...modelsForJob(MEMORY_RECHECK, bot.cheapModel ?? this.ctx.config.cheapModel),
          fallbackModel: null,
          maxTurns: 1,
        },
      });
      this.db
        .prepare(
          `INSERT INTO memory_recheck_jobs (id, workspace_id, run_id, note_count, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, workspaceId, run.id, input.length, now.toISOString());
      const row = this.db
        .prepare("SELECT * FROM memory_recheck_jobs WHERE id = ?")
        .get(id) as JobRow;
      return { job: jobView(row), run };
    })();
  }

  /**
   * A28: the recent shared activity a job reads: the newest messages of the most recently updated
   * threads that are not private chats, from the last 7 days, and the most recently updated
   * tasks. Private chats are never read.
   */
  activity(workspaceId: WorkspaceId, now: Date = new Date()): string {
    return this.snapshot(workspaceId, now).activity;
  }

  private snapshot(workspaceId: WorkspaceId, now: Date): RecheckSnapshot {
    const L = RECHECK_ACTIVITY_LIMITS;
    const since = new Date(now.getTime() - L.days * DAY_MS).toISOString();
    const botName = new Map(this.ctx.bots.list(workspaceId).map((b) => [b.id as string, b.name]));
    const author = (m: ThreadMessage) =>
      m.authorKind === "bot"
        ? (botName.get(m.authorId) ?? "a bot")
        : m.authorKind === "human"
          ? "a person"
          : "system";
    const lines: string[] = [`As of ${now.toISOString()}.`, "Shared threads (newest first):"];
    const evidence: RecheckSnapshot["evidence"] = [];
    let used = lines.join("\n").length;
    const add = (line: string) => {
      const redacted = sanitizeMemoryBody(line);
      if (used + redacted.length + 1 > L.total) return false;
      lines.push(redacted);
      used += redacted.length + 1;
      return true;
    };
    const source = (id: string, at: string, body: string, limit: number) => {
      const text = cut(sanitizeMemoryBody(body), limit);
      // Count the source text as well as the contextual line in the shared input budget.
      if (used + text.length + 1 > L.total || at > now.toISOString()) return;
      used += text.length + 1;
      evidence.push({ id, at, text, sha256: evidenceHash(text) });
    };
    const threads = this.ctx.threads
      .list(workspaceId)
      .filter((t) => t.privateToUserId === undefined && t.updatedAt >= since)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, L.threads);
    if (threads.length === 0) add("- none");
    for (const thread of threads) {
      add(`- ${thread.title ?? thread.id} (${thread.kind}, last update ${thread.updatedAt})`);
      const latest = this.ctx.messages.maxSeq(thread.id);
      for (const m of this.ctx.messages.list(thread.id, Math.max(0, latest - L.messagesPerThread)))
        if (m.ts >= since && m.ts <= now.toISOString()) {
          if (
            add(`  - ${m.ts} ${author(m)}: ${cut(sanitizeMemoryBody(m.body), L.messageChars)}`) &&
            m.authorKind !== "system"
          )
            source(`message:${m.id}`, m.ts, m.body, L.messageChars);
        }
    }
    const tasks = this.db
      .prepare(
        `SELECT title, status, next_action, blocked_reason, updated_at FROM tasks
          WHERE workspace_id = ? AND updated_at >= ? ORDER BY updated_at DESC, id DESC LIMIT ?`,
      )
      .all(workspaceId, since, L.tasks) as {
      title: string;
      status: string;
      next_action: string;
      blocked_reason: string;
      updated_at: string;
    }[];
    add("Tasks (most recently updated first):");
    if (tasks.length === 0) add("- none");
    for (const t of tasks) {
      const extra = [
        t.next_action ? `next: ${t.next_action}` : "",
        t.blocked_reason ? `blocked: ${t.blocked_reason}` : "",
      ]
        .filter(Boolean)
        .join("; ");
      add(
        `- ${t.updated_at} [${t.status}] ${cut(`${t.title}${extra ? ` (${extra})` : ""}`, L.taskChars)}`,
      );
    }
    return { asOf: now.toISOString(), activity: lines.join("\n"), evidence };
  }

  /** The sidecar reads current input versions and the evidence frozen when the job was queued. */
  jobRequest(run: RunRecord): ModelJobRequest | undefined {
    const workspaceId = this.ctx.bots.mustGet(run.botId).workspaceId;
    const notes: Extract<ModelJobRequest, { kind: "memory_recheck" }>["notes"] = [];
    for (const { entryId, version } of inputOf(run)) {
      const entry = this.ctx.memory.entries.get(entryId);
      if (
        !entry ||
        entry.workspaceId !== workspaceId ||
        entry.version !== version ||
        entry.tombstoned ||
        entry.invalidAt !== undefined ||
        entry.body.trim() === ""
      )
        continue;
      notes.push({
        id: entry.id,
        scope: entry.scope === "bot" ? "bot" : "workspace",
        body: entry.body,
        effectiveAt: entry.effectiveAt,
        ...(entry.lastConfirmedAt ? { lastConfirmedAt: entry.lastConfirmedAt } : {}),
      });
    }
    return notes.length
      ? {
          kind: "memory_recheck",
          notes,
          ...(recheckSnapshot(run) ?? { activity: "Legacy job: no frozen evidence was supplied." }),
        }
      : undefined;
  }

  /** A28: apply the verdicts that pass validation; the run's status follows the reply. */
  complete(run: RunRecord, ended: RunEnded, now: Date = new Date()): "succeeded" | "failed" {
    const jobId = String(run.config.memoryRecheckJobId ?? "");
    const row = this.db.prepare("SELECT * FROM memory_recheck_jobs WHERE id = ?").get(jobId) as
      | JobRow
      | undefined;
    const reply = ended.outcome === "completed" ? (ended.summary?.reply ?? "") : "";
    if (!row || row.run_id !== run.id || row.status !== "pending")
      return reply ? "succeeded" : "failed";
    const at = now.toISOString();
    const verdicts = reply ? parseMemoryRecheckReply(reply) : undefined;
    if (!verdicts) {
      this.db
        .prepare(
          `UPDATE memory_recheck_jobs SET status = 'failed', error = ?, finished_at = ?
            WHERE id = ? AND status = 'pending'`,
        )
        .run(
          (reply
            ? "The model did not return verdicts"
            : (ended.error ?? "The job did not finish")
          ).slice(0, 500),
          at,
          row.id,
        );
      return reply ? "succeeded" : "failed";
    }
    const workspaceId = row.workspace_id as WorkspaceId;
    const input = new Map(inputOf(run).map((n) => [n.entryId, n]));
    const by = decidedByModelRun(run.id);
    const counts = { still_true: 0, possibly_stale: 0, unclear: 0 };
    const seen = new Set<string>();
    this.db.transaction(() => {
      const flagOpen = this.db.prepare(
        "SELECT 1 FROM memory_revalidations WHERE id = ? AND workspace_id = ? AND status = 'open'",
      );
      const record = this.db.prepare(
        `UPDATE memory_revalidations SET model_verdict = ?, model_reason = ?, model_checked_at = ?,
           model_run_id = ?, model_entry_version = ? WHERE id = ?`,
      );
      for (const v of verdicts) {
        const sent = input.get(v.id);
        if (!sent || seen.has(v.id)) continue;
        const entry = this.ctx.memory.entries.get(sent.entryId);
        if (
          !entry ||
          entry.workspaceId !== workspaceId ||
          entry.version !== sent.version ||
          entry.tombstoned ||
          entry.invalidAt !== undefined ||
          !flagOpen.get(sent.flagId, workspaceId)
        )
          continue;
        seen.add(v.id);
        const verdict =
          v.verdict === "still_true" && !hasRenewalEvidence(run, entry, v.evidence)
            ? "unclear"
            : v.verdict;
        const reason =
          verdict !== v.verdict
            ? "No valid fresh supporting quote in this job's frozen evidence; confirmation withheld."
            : v.reason;
        record.run(verdict, reason, at, run.id, entry.version, sent.flagId);
        counts[verdict] += 1;
        if (verdict !== "still_true") continue;
        // A model confirmation: body, trust, authority and scope unchanged; `by` names the run.
        this.ctx.memory.entries.appendVersion(entry.id, "confirm", { lastConfirmedAt: at }, by);
        this.db
          .prepare(
            `UPDATE memory_revalidations SET status = 'still_true', decided_by = ?, decided_at = ?
              WHERE id = ? AND status = 'open'`,
          )
          .run(by, at, sent.flagId);
      }
      this.db
        .prepare(
          `UPDATE memory_recheck_jobs SET status = 'ready', still_true = ?, possibly_stale = ?,
             unclear = ?, dropped = ?, finished_at = ? WHERE id = ? AND status = 'pending'`,
        )
        .run(
          counts.still_true,
          counts.possibly_stale,
          counts.unclear,
          row.note_count - seen.size,
          at,
          row.id,
        );
    })();
    return "succeeded";
  }

  job(workspaceId: WorkspaceId, id: string): MemoryRecheckJob {
    const row = this.db
      .prepare("SELECT * FROM memory_recheck_jobs WHERE id = ? AND workspace_id = ?")
      .get(id, workspaceId) as JobRow | undefined;
    if (!row) throw new DeskmatesError("not_found", "Recheck job not found", { id });
    return jobView(row);
  }
}
