// Model organisation of learned memory (ADR-0011 amendment 4, A30 to A32). An Admin asks for it;
// it runs as a cheap-model job in the sidecar (ADR-0023 amendment 1) and the Gateway validates
// what comes back deterministically. Labels become browsing tags; splits become proposals a
// human accepts. Nothing here calls a model or changes trust, scope or a rule. Owner ruling
// 2026-10-14: it also runs once a day on its own (`requestDaily`); splits stay human-accepted.

import {
  DeskmatesError,
  MEMORY_ORGANIZE_MAX_NOTES,
  type MemoryOrganizeJob,
  type MemorySplitProposal,
  type ModelJobRequest,
  type RunEnded,
  type WorkspaceId,
  parseMemoryOrganizeReply,
  splitRejection,
  validTopicLabel,
} from "@deskmates/contracts";
import type { GatewayContext } from "../context.js";
import { newId } from "../db/ids.js";
import type { RunRecord } from "../ledger/runs.js";
import { modelsForJob } from "../scheduler/job-models.js";
import { readMaintenanceSettings } from "./maintenance-settings.js";
import { writeFact } from "./recency.js";
import { undoEntry } from "./versions.js";

export const MEMORY_ORGANIZE = "memory_organize";
/** Who requests the daily job (A30). */
export const DAILY_REQUESTER = "system:memory-maintenance";

interface JobRow {
  id: string;
  workspace_id: string;
  run_id: string;
  status: MemoryOrganizeJob["status"];
  note_count: number;
  labels_kept: number;
  labels_dropped: number;
  splits_kept: number;
  splits_dropped: number;
  error: string | null;
  requested_by: string;
  created_at: string;
  finished_at: string | null;
}

interface SplitRow {
  id: string;
  workspace_id: string;
  entry_id: string;
  entry_version: number;
  body: string;
  job_id: string;
  status: MemorySplitProposal["status"];
  created_at: string;
  decided_by: string | null;
  decided_at: string | null;
}

interface PartRow {
  position: number;
  body: string;
  entry_id: string | null;
  entry_version: number | null;
}

function jobView(row: JobRow): MemoryOrganizeJob {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    status: row.status,
    runId: row.run_id,
    noteCount: row.note_count,
    labelsKept: row.labels_kept,
    labelsDropped: row.labels_dropped,
    splitsKept: row.splits_kept,
    splitsDropped: row.splits_dropped,
    ...(row.error ? { error: row.error } : {}),
    requestedBy: row.requested_by,
    createdAt: row.created_at,
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
  };
}

/** The (entry, version) pairs a job was given, from its run config (A30). */
function inputOf(run: RunRecord): Map<string, number> {
  const raw = run.config.memoryOrganizeInput;
  const pairs = Array.isArray(raw) ? raw : [];
  const input = new Map<string, number>();
  for (const pair of pairs)
    if (Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "number")
      input.set(pair[0], pair[1]);
  return input;
}

export class MemoryOrganizer {
  constructor(private readonly ctx: GatewayContext) {}

  private get db() {
    return this.ctx.db;
  }

  private get entries() {
    return this.ctx.memory.entries;
  }

  job(workspaceId: WorkspaceId, id: string): MemoryOrganizeJob {
    const row = this.db
      .prepare("SELECT * FROM memory_organize_jobs WHERE id = ? AND workspace_id = ?")
      .get(id, workspaceId) as JobRow | undefined;
    if (!row) throw new DeskmatesError("not_found", "Organisation job not found", { id });
    return jobView(row);
  }

  /** The newest job of a workspace, if any. */
  latest(workspaceId: WorkspaceId): MemoryOrganizeJob | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM memory_organize_jobs WHERE workspace_id = ?
          ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(workspaceId) as JobRow | undefined;
    return row ? jobView(row) : undefined;
  }

  /**
   * A30: queue one job for a workspace's newest current notes. A pending job of this workspace is
   * returned instead, so a repeated request creates nothing.
   */
  request(input: { workspaceId: WorkspaceId; requestedBy: string }): {
    job: MemoryOrganizeJob;
    run?: RunRecord;
  } {
    return this.db.transaction(() => {
      const pending = this.db
        .prepare("SELECT * FROM memory_organize_jobs WHERE workspace_id = ? AND status = 'pending'")
        .get(input.workspaceId) as JobRow | undefined;
      if (pending) return { job: jobView(pending) };
      const notes = this.db
        .prepare(
          `SELECT id, version FROM memory_entries
            WHERE workspace_id = ? AND kind = 'note' AND scope IN ('workspace', 'bot')
              AND tombstoned = 0 AND invalid_at IS NULL AND episode_id IS NULL
            ORDER BY (topic_source = 'model'), COALESCE(effective_at, observed_at) DESC, id DESC
            LIMIT ?`,
        )
        .all(input.workspaceId, MEMORY_ORGANIZE_MAX_NOTES) as { id: string; version: number }[];
      if (notes.length === 0)
        throw new DeskmatesError("validation", "This workspace has no current notes to organise");
      // The job is attributed to the workspace's oldest active bot; it reads no bot context.
      const bot = this.ctx.bots.list(input.workspaceId)[0];
      if (!bot) throw new DeskmatesError("validation", "This workspace has no bot to run the job");
      const id = newId("morg");
      const run = this.ctx.runs.create({
        botId: bot.id,
        lane: "background",
        triggerKind: "cron",
        triggerRef: `${MEMORY_ORGANIZE}:${id}`,
        triggerPayload: { prompt: "" },
        config: {
          ...this.ctx.runConfig(),
          runType: MEMORY_ORGANIZE,
          memoryOrganizeJobId: id,
          memoryOrganizeVersion: 1,
          memoryOrganizeInput: notes.map((note) => [note.id, note.version]),
          ...modelsForJob(MEMORY_ORGANIZE, bot.cheapModel ?? this.ctx.config.cheapModel),
          fallbackModel: null,
          maxTurns: 1,
        },
      });
      this.db
        .prepare(
          `INSERT INTO memory_organize_jobs
             (id, workspace_id, run_id, note_count, requested_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.workspaceId, run.id, notes.length, input.requestedBy, run.createdAt);
      return { job: this.job(input.workspaceId, id), run };
    })();
  }

  /**
   * A30 as ruled 2026-10-14: the daily job of a workspace, queued by the periodic pass when daily
   * organisation is on, a current note has no model label, and no job was created in 24 hours.
   */
  requestDaily(
    workspaceId: WorkspaceId,
    now: Date = new Date(),
  ): { job: MemoryOrganizeJob; run?: RunRecord } | undefined {
    if (!readMaintenanceSettings(this.db, workspaceId).organizeDaily) return undefined;
    const since = new Date(now.getTime() - 86_400_000).toISOString();
    const recent = this.db
      .prepare("SELECT 1 FROM memory_organize_jobs WHERE workspace_id = ? AND created_at > ?")
      .get(workspaceId, since);
    if (recent) return undefined;
    const unlabelled = this.db
      .prepare(
        `SELECT 1 FROM memory_entries
          WHERE workspace_id = ? AND kind = 'note' AND scope IN ('workspace', 'bot')
            AND tombstoned = 0 AND invalid_at IS NULL AND episode_id IS NULL
            AND topic_source <> 'model' LIMIT 1`,
      )
      .get(workspaceId);
    if (!unlabelled || this.ctx.bots.list(workspaceId).length === 0) return undefined;
    return this.request({ workspaceId, requestedBy: DAILY_REQUESTER });
  }

  /** The sidecar's job: the bodies at the versions recorded on the run; forgotten ones left out. */
  jobRequest(run: RunRecord): ModelJobRequest | undefined {
    const notes: { id: string; body: string }[] = [];
    for (const [id, version] of inputOf(run)) {
      const recorded = this.entries.version(id, version);
      if (recorded && !recorded.redacted && recorded.body.trim() !== "")
        notes.push({ id, body: recorded.body });
    }
    return notes.length ? { kind: "memory_organize", notes } : undefined;
  }

  /** A31, A32: keep what passes the deterministic checks; the run's status follows the reply. */
  complete(run: RunRecord, ended: RunEnded): "succeeded" | "failed" {
    const jobId = String(run.config.memoryOrganizeJobId ?? "");
    const row = this.db.prepare("SELECT * FROM memory_organize_jobs WHERE id = ?").get(jobId) as
      | JobRow
      | undefined;
    const reply = ended.outcome === "completed" ? (ended.summary?.reply ?? "") : "";
    if (!row || row.run_id !== run.id || row.status !== "pending")
      return reply ? "succeeded" : "failed";
    const now = new Date().toISOString();
    const parsed = reply ? parseMemoryOrganizeReply(reply) : undefined;
    if (!parsed) {
      this.db
        .prepare(
          `UPDATE memory_organize_jobs SET status = 'failed', error = ?, finished_at = ?
            WHERE id = ? AND status = 'pending'`,
        )
        .run(
          (reply
            ? "The model did not return labels and splits"
            : (ended.error ?? "The job did not finish")
          ).slice(0, 500),
          now,
          row.id,
        );
      return reply ? "succeeded" : "failed";
    }
    const input = inputOf(run);
    const workspaceId = row.workspace_id as WorkspaceId;
    const atVersion = (id: string) => {
      const version = input.get(id);
      const entry = version === undefined ? undefined : this.entries.get(id);
      return entry &&
        entry.workspaceId === workspaceId &&
        entry.version === version &&
        !entry.tombstoned &&
        entry.invalidAt === undefined
        ? entry
        : undefined;
    };
    const counts = { labelsKept: 0, labelsDropped: 0, splitsKept: 0, splitsDropped: 0 };
    this.db.transaction(() => {
      const labelled = new Set<string>();
      for (const proposal of parsed.labels) {
        const entry = atVersion(proposal.id);
        const label = validTopicLabel(proposal.label);
        if (!entry || !label || labelled.has(entry.id)) {
          counts.labelsDropped += 1;
          continue;
        }
        labelled.add(entry.id);
        this.db
          .prepare(
            `UPDATE memory_entries SET topic = ?, topic_label = ?, topic_set = 1,
               topic_source = 'model', topic_run_id = ? WHERE id = ? AND version = ?`,
          )
          .run(label.key, label.label, run.id, entry.id, entry.version);
        counts.labelsKept += 1;
      }
      const pending = this.db.prepare(
        "SELECT 1 FROM memory_split_proposals WHERE entry_id = ? AND status = 'pending'",
      );
      for (const proposal of parsed.splits) {
        const entry = atVersion(proposal.id);
        const parts = proposal.parts.map((part) => part.trim());
        if (!entry || pending.get(entry.id) || splitRejection(entry.body, parts) !== undefined) {
          counts.splitsDropped += 1;
          continue;
        }
        const id = newId("msplit");
        this.db
          .prepare(
            `INSERT INTO memory_split_proposals
               (id, workspace_id, entry_id, entry_version, body, job_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, workspaceId, entry.id, entry.version, entry.body, row.id, now);
        const insertPart = this.db.prepare(
          "INSERT INTO memory_split_parts (proposal_id, position, body) VALUES (?, ?, ?)",
        );
        parts.forEach((part, i) => insertPart.run(id, i + 1, part));
        counts.splitsKept += 1;
      }
      this.db
        .prepare(
          `UPDATE memory_organize_jobs SET status = 'ready', labels_kept = ?, labels_dropped = ?,
             splits_kept = ?, splits_dropped = ?, finished_at = ? WHERE id = ? AND status = 'pending'`,
        )
        .run(
          counts.labelsKept,
          counts.labelsDropped,
          counts.splitsKept,
          counts.splitsDropped,
          now,
          row.id,
        );
    })();
    return "succeeded";
  }

  /** A31: every model label of the workspace back to the deterministic topic of A20. */
  resetLabels(workspaceId: WorkspaceId): number {
    const changed = this.db
      .prepare(
        `UPDATE memory_entries SET topic_set = 0, topic_source = 'rule', topic_run_id = NULL
          WHERE workspace_id = ? AND topic_source = 'model'`,
      )
      .run(workspaceId).changes;
    this.entries.ensureTopics(workspaceId);
    return changed;
  }

  split(workspaceId: WorkspaceId, id: string): MemorySplitProposal {
    const row = this.db
      .prepare("SELECT * FROM memory_split_proposals WHERE id = ? AND workspace_id = ?")
      .get(id, workspaceId) as SplitRow | undefined;
    if (!row) throw new DeskmatesError("not_found", "Split proposal not found", { id });
    return this.splitView(row);
  }

  /** Pending splits, newest first, keyset `created_at DESC, id DESC`, with the exact total. */
  pendingSplits(
    workspaceId: WorkspaceId,
    page: { limit: number; after?: readonly [string, string] },
  ): { splits: MemorySplitProposal[]; more: boolean; total: number } {
    const after = page.after;
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_split_proposals WHERE workspace_id = ? AND status = 'pending'
            AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
          ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(
        workspaceId,
        after?.[0] ?? null,
        after?.[0] ?? null,
        after?.[0] ?? null,
        after?.[1] ?? null,
        page.limit + 1,
      ) as SplitRow[];
    const total = (
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM memory_split_proposals WHERE workspace_id = ? AND status = 'pending'",
        )
        .get(workspaceId) as { n: number }
    ).n;
    return {
      splits: rows.slice(0, page.limit).map((row) => this.splitView(row)),
      more: rows.length > page.limit,
      total,
    };
  }

  /**
   * A32: a human accepts, rejects or undoes a split. Accepting closes the original and writes
   * each part through the recency writer with the original's store, trust and time; undo forgets
   * the parts it created and reopens the original. Audited in the same transaction.
   */
  decideSplit(input: {
    workspaceId: WorkspaceId;
    id: string;
    decision: unknown;
    by: string;
  }): MemorySplitProposal {
    const decision = input.decision;
    if (decision !== "accept" && decision !== "reject" && decision !== "undo")
      throw new DeskmatesError("validation", "Expected accept, reject or undo", {
        field: "decision",
      });
    return this.db.transaction(() => {
      const proposal = this.split(input.workspaceId, input.id);
      const at = new Date().toISOString();
      if (decision === "undo") this.undo(proposal, input.by);
      else {
        if (proposal.status !== "pending")
          throw new DeskmatesError("invalid_transition", "This split was already decided");
        if (decision === "accept") this.accept(proposal, input.by, at);
        this.db
          .prepare(
            `UPDATE memory_split_proposals SET status = ?, decided_by = ?, decided_at = ?
              WHERE id = ?`,
          )
          .run(decision === "accept" ? "accepted" : "rejected", input.by, at, proposal.id);
      }
      this.ctx.audit.record({
        action: "memory.split_decide",
        actor: input.by,
        workspaceId: input.workspaceId,
        targetKind: "memory_entry",
        targetId: proposal.entryId,
        after: { decision, split: proposal.id, parts: proposal.parts.length },
      });
      return this.split(input.workspaceId, proposal.id);
    })();
  }

  private accept(proposal: MemorySplitProposal, by: string, at: string): void {
    const original = this.entries.mustGetIn(proposal.workspaceId as WorkspaceId, proposal.entryId);
    if (
      original.version !== proposal.entryVersion ||
      original.tombstoned ||
      original.invalidAt !== undefined
    )
      throw new DeskmatesError(
        "invalid_transition",
        "The note changed after this split was proposed",
      );
    // Closed first, so a part with the original's fact key never meets it as a current value.
    this.entries.closeForSupersession(original.id, at, by);
    const record = this.db.prepare(
      `UPDATE memory_split_parts SET entry_id = ?, entry_version = ?
        WHERE proposal_id = ? AND position = ?`,
    );
    proposal.parts.forEach((body, i) => {
      const result = writeFact(this.entries, {
        workspaceId: original.workspaceId,
        scope: original.scope,
        kind: "note",
        ...(original.botId ? { botId: original.botId } : {}),
        ...(original.threadId ? { threadId: original.threadId } : {}),
        body,
        authority: original.authority,
        trust: original.trust,
        ...(original.sourceRunId ? { sourceRunId: original.sourceRunId } : {}),
        sourceKind: original.sourceKind,
        derivedFrom: [original.id],
        observedAt: original.observedAt,
        effectiveAt: original.effectiveAt,
        effectiveBasis: original.effectiveBasis,
        by,
      });
      // A part folded into an existing note (A10) is that note's business, not this split's.
      if (result.kind === "current" || result.kind === "history")
        record.run(result.entry.id, result.entry.version, proposal.id, i + 1);
    });
  }

  private undo(proposal: MemorySplitProposal, by: string): void {
    if (proposal.status !== "accepted")
      throw new DeskmatesError("invalid_transition", "Only an accepted split can be undone");
    const workspaceId = proposal.workspaceId as WorkspaceId;
    const original = this.entries.mustGetIn(workspaceId, proposal.entryId);
    const parts = this.parts(proposal.id);
    const unchanged =
      !original.tombstoned &&
      original.version === proposal.entryVersion + 1 &&
      parts.every((part) => {
        if (!part.entry_id) return true;
        const entry = this.entries.get(part.entry_id);
        return entry && !entry.tombstoned && entry.version === part.entry_version;
      });
    if (!unchanged)
      throw new DeskmatesError(
        "invalid_transition",
        "The note or a part changed after the split; change them through their own versions",
      );
    for (const part of parts) if (part.entry_id) this.entries.tombstone(part.entry_id, by);
    undoEntry(this.entries, workspaceId, original.id, by);
    this.db
      .prepare(
        "UPDATE memory_split_proposals SET status = 'undone', decided_by = ?, decided_at = ? WHERE id = ?",
      )
      .run(by, new Date().toISOString(), proposal.id);
  }

  private parts(proposalId: string): PartRow[] {
    return this.db
      .prepare(
        "SELECT position, body, entry_id, entry_version FROM memory_split_parts WHERE proposal_id = ? ORDER BY position",
      )
      .all(proposalId) as PartRow[];
  }

  private splitView(row: SplitRow): MemorySplitProposal {
    const parts = this.parts(row.id);
    const run = this.db
      .prepare("SELECT run_id FROM memory_organize_jobs WHERE id = ?")
      .get(row.job_id) as { run_id: string } | undefined;
    const created = parts.flatMap((part) => (part.entry_id ? [part.entry_id] : []));
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      entryId: row.entry_id,
      entryVersion: row.entry_version,
      body: row.body,
      parts: parts.map((part) => part.body),
      status: row.status,
      runId: run?.run_id ?? "",
      createdAt: row.created_at,
      ...(row.decided_by ? { decidedBy: row.decided_by } : {}),
      ...(row.decided_at ? { decidedAt: row.decided_at } : {}),
      ...(created.length ? { partEntryIds: created } : {}),
    };
  }
}
