// The run ledger. Every trigger creates a row here before anything else happens; every status
// change goes through `transition`, which enforces the contracts state machine.

import {
  type BotId,
  DeskmatesError,
  PARKED_RUN_STATUSES,
  type Run,
  type RunFailureClass,
  type RunId,
  type RunLane,
  type RunResumePayload,
  type RunStatus,
  type RunSummary,
  type RunTriggerKind,
  type ThreadId,
  type WorkspaceId,
  canTransition,
  isTerminal,
  occupiesLane,
} from "@deskmates/contracts";
import { newId, nowIso, parseJson } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";
import { failureClassSql } from "./failure-class.js";

interface RunRow {
  id: string;
  bot_id: string;
  thread_id: string | null;
  lane: RunLane;
  trigger_kind: RunTriggerKind;
  trigger_ref: string;
  status: RunStatus;
  attempt: number;
  sdk_session_id: string | null;
  resume_payload_json: string | null;
  trigger_payload_json: string | null;
  delivered_seq: number | null;
  config_json: string;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  summary_json: string | null;
}

/** Run plus the Gateway-only bookkeeping columns the API also exposes. */
export interface RunRecord extends Run {
  createdAt: string;
  /** Highest thread seq delivered to the bot; what `last_seen_seq` advances to on success. */
  deliveredSeq?: number;
  /**
   * What fired the run, captured on the row at trigger time: the cron entry's prompt, or the
   * webhook body as received. A thread wake has none; its payload is built from the transcript.
   */
  triggerPayload?: Record<string, unknown>;
  config: Record<string, unknown>;
  error?: string;
}

/**
 * SQL condition: the run (table alias `alias`) is not in another person's private chat
 * (ADR-0022 amendment 6 W7). Takes one parameter, the viewer's user id or null.
 */
function notPrivateToOthers(alias: string): string {
  return `(${alias}.thread_id IS NULL OR NOT EXISTS (SELECT 1 FROM threads t
    WHERE t.id = ${alias}.thread_id AND t.private_to_user_id IS NOT NULL
      AND t.private_to_user_id IS NOT ?))`;
}

/** The scope of a run page (`RunStore.listPage`). */
export interface RunPageFilter {
  tenantId: string;
  workspaceIds?: readonly string[];
  workspaceId?: WorkspaceId;
  threadId?: ThreadId;
  botId?: BotId;
  phase?: "active" | "finished";
  /** The person reading; another person's private chat is left out. */
  viewerUserId?: string;
  /** Only these statuses (issue #11). */
  statuses?: readonly RunStatus[];
  lane?: RunLane;
  /** `created_at` at or after this canonical ISO time. */
  since?: string;
  /** `created_at` before this canonical ISO time. */
  until?: string;
  /** Only runs whose `error` classifies as this (`failure-class.ts`, ADR-0042 decision 1). */
  failureClass?: RunFailureClass;
  /** Case-insensitive substring of `error`. */
  errorText?: string;
}

export interface CreateRunInput {
  botId: BotId;
  threadId?: ThreadId;
  lane: RunLane;
  triggerKind: RunTriggerKind;
  triggerRef: string;
  /** Cron prompt or webhook body; stored before anything else happens. */
  triggerPayload?: Record<string, unknown>;
  config?: Record<string, unknown>;
}

const ALL_STATUSES: readonly RunStatus[] = [
  "queued",
  "running",
  "stalled",
  "waiting_approval_live",
  "waiting_approval",
  "waiting_browser",
  "waiting_continuation",
  "succeeded",
  "silent",
  "failed",
  "cancelled",
  "stopped",
];

/** Statuses that hold a lane while a sidecar process is (or is about to be) alive. */
const LANE_HOLDING_STATUSES = ALL_STATUSES.filter((s) => occupiesLane(s) && s !== "queued");

/**
 * The scheduler's work list, run on every kick. Exported so the migration test can assert that
 * `runs_status_created` (migration 0004) covers it instead of scanning the whole table.
 */
export const QUEUED_RUNS_SQL = `SELECT r.* FROM runs r
  JOIN bots b ON b.id = r.bot_id
  JOIN workspaces w ON w.id = b.workspace_id
  WHERE r.status = 'queued' AND b.archived_at IS NULL AND w.archived_at IS NULL
  ORDER BY r.created_at, r.id`;

/**
 * Parked runs whose approval has been decided: the scheduler's resume work list (ADR-0002
 * amendment 2, "resume keeps the ledger whole"). The approval id lives in the resume payload the
 * sidecar sent with `run_ended(deferred)`; the generated column `resume_approval_id` exposes it.
 */
export const RESUMABLE_RUNS_SQL = `SELECT r.* FROM runs r
   JOIN approvals a ON a.id = r.resume_approval_id
   WHERE (r.status = 'waiting_approval' AND a.decision IS NOT NULL)
      OR (r.status = 'waiting_continuation' AND a.decision = 'allow_once')
   ORDER BY r.created_at, r.id`;

export class RunStore {
  constructor(private readonly db: GatewayDb) {}

  create(input: CreateRunInput): RunRecord {
    const bot = this.db
      .prepare(
        `SELECT b.workspace_id FROM bots b JOIN workspaces w ON w.id = b.workspace_id
         WHERE b.id = ? AND b.archived_at IS NULL AND w.archived_at IS NULL`,
      )
      .get(input.botId) as { workspace_id: string } | undefined;
    if (bot === undefined) {
      throw new DeskmatesError(
        "invalid_transition",
        "a trashed bot or workspace cannot start a run",
        {
          botId: input.botId,
        },
      );
    }
    const id = newId("run") as RunId;
    this.db
      .prepare(
        `INSERT INTO runs (id, workspace_id, bot_id, thread_id, lane, trigger_kind, trigger_ref, status,
           trigger_payload_json, config_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
      )
      .run(
        id,
        bot.workspace_id,
        input.botId,
        input.threadId ?? null,
        input.lane,
        input.triggerKind,
        input.triggerRef,
        input.triggerPayload ? JSON.stringify(input.triggerPayload) : null,
        JSON.stringify(input.config ?? {}),
        nowIso(),
      );
    return this.mustGet(id);
  }

  get(id: RunId): RunRecord | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
    return row ? toRun(row) : undefined;
  }

  mustGet(id: RunId): RunRecord {
    const r = this.get(id);
    if (!r) throw new DeskmatesError("not_found", `run ${id} not found`, { runId: id });
    return r;
  }

  list(filter: { threadId?: ThreadId; botId?: BotId; tenantId?: string } = {}): RunRecord[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.tenantId !== undefined) {
      clauses.push("workspace_id IN (SELECT id FROM workspaces WHERE tenant_id = ?)");
      params.push(filter.tenantId);
    }
    if (filter.threadId) {
      clauses.push("thread_id = ?");
      params.push(filter.threadId);
    }
    if (filter.botId) {
      clauses.push("bot_id = ?");
      params.push(filter.botId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM runs ${where} ORDER BY created_at, id`)
      .all(...params) as RunRow[];
    return rows.map(toRun);
  }

  /**
   * One page of runs, newest first (`created_at DESC, id DESC`), for the run API (#113 slice R).
   * `phase` keeps only unfinished (`active`) or terminal (`finished`) runs. `workspaceIds`
   * narrows to the caller's workspaces; absent means the whole tenant. A run in another person's
   * private chat is never listed (`viewerUserId`, ADR-0022 amendment 6 W7). Reads `limit + 1`
   * rows so the caller can tell whether more exist; `active` reads every unfinished run.
   */
  listPage(filter: RunPageFilter, page: { limit?: number; after?: [string, string] }): RunRecord[] {
    const clauses = ["r.workspace_id IN (SELECT id FROM workspaces WHERE tenant_id = ?)"];
    const params: (string | number | null)[] = [filter.tenantId];
    if (filter.workspaceIds !== undefined) {
      clauses.push("r.workspace_id IN (SELECT value FROM json_each(?))");
      params.push(JSON.stringify(filter.workspaceIds));
    }
    if (filter.workspaceId !== undefined) {
      clauses.push("r.workspace_id = ?");
      params.push(filter.workspaceId);
    }
    if (filter.threadId !== undefined) {
      clauses.push("r.thread_id = ?");
      params.push(filter.threadId);
    }
    if (filter.botId !== undefined) {
      clauses.push("r.bot_id = ?");
      params.push(filter.botId);
    }
    if (filter.phase !== undefined) {
      const terminal = ALL_STATUSES.filter((s) => isTerminal(s));
      clauses.push(
        `r.status ${filter.phase === "finished" ? "IN" : "NOT IN"} (${terminal.map(() => "?").join(", ")})`,
      );
      params.push(...terminal);
    }
    if (filter.statuses !== undefined) {
      clauses.push("r.status IN (SELECT value FROM json_each(?))");
      params.push(JSON.stringify(filter.statuses));
    }
    if (filter.lane !== undefined) {
      clauses.push("r.lane = ?");
      params.push(filter.lane);
    }
    if (filter.since !== undefined) {
      clauses.push("r.created_at >= ?");
      params.push(filter.since);
    }
    if (filter.until !== undefined) {
      clauses.push("r.created_at < ?");
      params.push(filter.until);
    }
    if (filter.failureClass !== undefined) {
      clauses.push(`${failureClassSql("r.error")} = ?`);
      params.push(filter.failureClass);
    }
    if (filter.errorText !== undefined) {
      clauses.push("instr(lower(r.error), lower(?)) > 0");
      params.push(filter.errorText);
    }
    clauses.push(notPrivateToOthers("r"));
    params.push(filter.viewerUserId ?? null);
    if (page.after) {
      clauses.push("(r.created_at < ? OR (r.created_at = ? AND r.id < ?))");
      params.push(page.after[0], page.after[0], page.after[1]);
    }
    const limit = page.limit === undefined ? "" : ` LIMIT ${Math.trunc(page.limit) + 1}`;
    const rows = this.db
      .prepare(
        `SELECT r.* FROM runs r WHERE ${clauses.join(" AND ")}
          ORDER BY r.created_at DESC, r.id DESC${limit}`,
      )
      .all(...params) as RunRow[];
    return rows.map(toRun);
  }

  /**
   * Each bot's newest run in a workspace, for the Contacts rail (#113 slice R): one indexed
   * lookup per bot (`runs(bot_id, created_at, id)`), never the workspace's whole history.
   */
  latestPerBot(workspaceId: WorkspaceId, viewerUserId?: string): RunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT r.* FROM bots b JOIN runs r ON r.id = (
           SELECT x.id FROM runs x WHERE x.bot_id = b.id AND ${notPrivateToOthers("x")}
             ORDER BY x.created_at DESC, x.id DESC LIMIT 1)
         WHERE b.workspace_id = ?
         ORDER BY b.name, b.id`,
      )
      .all(viewerUserId ?? null, workspaceId) as RunRow[];
    return rows.map(toRun);
  }

  /**
   * The workspace's newest run that recorded a memory index observation (`config.memory.counts`),
   * for Learned memory (#113 slice R). Walks the workspace's runs newest first and stops at the
   * first match.
   */
  latestMemoryIndex(workspaceId: WorkspaceId, viewerUserId?: string): RunRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM runs r WHERE r.workspace_id = ? AND ${notPrivateToOthers("r")}
           AND json_type(r.config_json, '$.memory.counts') = 'object'
         ORDER BY r.created_at DESC, r.id DESC LIMIT 1`,
      )
      .get(workspaceId, viewerUserId ?? null) as RunRow | undefined;
    return row ? toRun(row) : undefined;
  }

  /** Oldest-first queued runs, the scheduler's work list. */
  listQueued(): RunRecord[] {
    const rows = this.db.prepare(QUEUED_RUNS_SQL).all() as RunRow[];
    return rows.map(toRun);
  }

  /** A queued wake for `(bot, thread)`, used to coalesce (ADR-0005 item 8). */
  findQueued(botId: BotId, threadId: ThreadId): RunRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM runs WHERE bot_id = ? AND thread_id = ? AND status = 'queued' ORDER BY created_at LIMIT 1",
      )
      .get(botId, threadId) as RunRow | undefined;
    return row ? toRun(row) : undefined;
  }

  listQueuedInThread(threadId: ThreadId): RunRecord[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM runs WHERE thread_id = ? AND status = 'queued' ORDER BY created_at, id",
        )
        .all(threadId) as RunRow[]
    ).map(toRun);
  }

  /** Any unfinished run for this bot/session pair, including a parked session owner. */
  liveInThread(botId: BotId, threadId: ThreadId): boolean {
    const statuses = ALL_STATUSES.filter((status) => !isTerminal(status));
    const placeholders = statuses.map(() => "?").join(", ");
    return (
      this.db
        .prepare(
          `SELECT 1 FROM runs WHERE bot_id = ? AND thread_id = ?
       AND status IN (${placeholders}) LIMIT 1`,
        )
        .get(botId, threadId, ...statuses) !== undefined
    );
  }

  /**
   * The bot's run for an exact trigger reference. This is what makes a trigger idempotent: the
   * cron runner's reference carries the minute, so a tick delivered twice, a restart inside the
   * same minute, and a clock that went backwards all find the run that already exists.
   */
  findByTriggerRef(botId: BotId, triggerRef: string): RunRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM runs WHERE bot_id = ? AND trigger_ref = ? LIMIT 1")
      .get(botId, triggerRef) as RunRow | undefined;
    return row ? toRun(row) : undefined;
  }

  /**
   * The bot's own newest runs that reached the sandbox, newest first: no Gateway job hosted on it
   * (`run_type`), none still queued. "Last run used SOUL v N" reads the first (ADR-0043).
   */
  latestStartedOwnRuns(botId: BotId, limit: number): RunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM runs WHERE bot_id = ? AND run_type IS NULL AND started_at IS NOT NULL
           ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(botId, limit) as RunRow[];
    return rows.map(toRun);
  }

  /** The bot's newest run of this trigger kind, e.g. its latest welcome (ADR-0024 decision 9). */
  latestOfTrigger(botId: BotId, triggerKind: RunTriggerKind): RunRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM runs WHERE bot_id = ? AND trigger_kind = ?
           ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(botId, triggerKind) as RunRow | undefined;
    return row ? toRun(row) : undefined;
  }

  /**
   * The bot's oldest run of this trigger kind whose reference starts with `prefix` and which has
   * not reached a terminal status — "the previous round has not finished" (design v0.3 §3.4).
   * Every non-terminal status counts, not only the ones that hold a lane: a round parked on an
   * approval (`waiting_approval`, `waiting_browser`) holds no lane, but it is still going, and
   * treating it as finished fires the next minute's round and asks the human a second time.
   * `substr` rather than `LIKE`, so a prefix never has to be escaped.
   */
  findLiveByTriggerPrefix(
    botId: BotId,
    triggerKind: RunTriggerKind,
    prefix: string,
  ): RunRecord | undefined {
    const statuses = ALL_STATUSES.filter((s) => !isTerminal(s));
    const placeholders = statuses.map(() => "?").join(", ");
    const row = this.db
      .prepare(
        `SELECT * FROM runs
           WHERE bot_id = ? AND trigger_kind = ? AND substr(trigger_ref, 1, ?) = ?
             AND status IN (${placeholders})
           ORDER BY created_at, id LIMIT 1`,
      )
      .get(botId, triggerKind, prefix.length, prefix, ...statuses) as RunRow | undefined;
    return row ? toRun(row) : undefined;
  }

  /**
   * Runs of the workspace's bots with a live sidecar: the ones whose browser tools start waiting
   * the moment a human takes the workspace lock, and the ones the takeover is recorded on. A
   * queued run has no process yet and a parked one is not asking for the browser.
   */
  listLiveInWorkspace(workspaceId: WorkspaceId): RunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT r.* FROM runs r JOIN bots b ON b.id = r.bot_id
           WHERE b.workspace_id = ? AND r.status IN ('running', 'stalled', 'waiting_approval_live')
           ORDER BY r.created_at, r.id`,
      )
      .all(workspaceId) as RunRow[];
    return rows.map(toRun);
  }

  /** Every non-terminal run of the workspace's bots, oldest first; the capacity report reads it. */
  listOpenInWorkspace(workspaceId: WorkspaceId): RunRecord[] {
    const open = ALL_STATUSES.filter((s) => !isTerminal(s));
    const placeholders = open.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT r.* FROM runs r JOIN bots b ON b.id = r.bot_id
           WHERE b.workspace_id = ? AND r.status IN (${placeholders})
           ORDER BY r.created_at, r.id`,
      )
      .all(workspaceId, ...open) as RunRow[];
    return rows.map(toRun);
  }

  /** How many runs of this trigger kind the bot has queued; the webhook queue cap reads it. */
  countQueued(botId: BotId, triggerKind: RunTriggerKind): number {
    const row = this.db
      .prepare(
        "SELECT count(*) AS n FROM runs WHERE bot_id = ? AND trigger_kind = ? AND status = 'queued'",
      )
      .get(botId, triggerKind) as { n: number };
    return row.n;
  }

  /** True when the bot already has a live run on this lane (one run per lane per bot). */
  laneBusy(botId: BotId, lane: RunLane): boolean {
    const placeholders = LANE_HOLDING_STATUSES.map(() => "?").join(", ");
    const row = this.db
      .prepare(
        `SELECT 1 FROM runs WHERE bot_id = ? AND lane = ? AND status IN (${placeholders}) LIMIT 1`,
      )
      .get(botId, lane, ...LANE_HOLDING_STATUSES);
    return row !== undefined;
  }

  /** A walk waits behind queued and live work on the member's lane (ADR-0005 definition). */
  laneOccupiedForWalk(botId: BotId, lane: RunLane): boolean {
    const livePlaceholders = LANE_HOLDING_STATUSES.map(() => "?").join(", ");
    const parked = [...PARKED_RUN_STATUSES];
    const parkedPlaceholders = parked.map(() => "?").join(", ");
    const row = this.db
      .prepare(
        `SELECT 1 FROM runs candidate
         WHERE candidate.bot_id = ? AND candidate.lane = ? AND (
           candidate.status IN (${livePlaceholders}) OR (
             candidate.status = 'queued' AND NOT EXISTS (
               SELECT 1 FROM runs owner
               WHERE owner.bot_id = candidate.bot_id
                 AND owner.thread_id = candidate.thread_id
                 AND owner.status IN (${parkedPlaceholders})
             )
           )
         ) LIMIT 1`,
      )
      .get(botId, lane, ...LANE_HOLDING_STATUSES, ...parked);
    return row !== undefined;
  }

  /**
   * True when a run of this bot in this thread is parked (`waiting_approval`, `waiting_browser`).
   * A parked run holds no lane but still owns the `(bot, thread)` SDK session it will resume, so
   * a queued run of the same pair waits for it (ADR-0002 amendment 2, "a parked run holds its
   * thread").
   */
  parkedInThread(botId: BotId, threadId: ThreadId): boolean {
    const statuses = [...PARKED_RUN_STATUSES];
    const placeholders = statuses.map(() => "?").join(", ");
    const row = this.db
      .prepare(
        `SELECT 1 FROM runs WHERE bot_id = ? AND thread_id = ? AND status IN (${placeholders}) LIMIT 1`,
      )
      .get(botId, threadId, ...statuses);
    return row !== undefined;
  }

  /** Parked runs whose approval is decided, oldest first. */
  listResumable(): RunRecord[] {
    return (this.db.prepare(RESUMABLE_RUNS_SQL).all() as RunRow[]).map(toRun);
  }

  /** A fake clock can pass `now` for the 24-hour continuation expiry test. */
  listExpiredContinuations(now: Date = new Date()): RunRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM runs WHERE status = 'waiting_continuation'
       AND continuation_expires_at <= ?
       ORDER BY created_at, id`,
        )
        .all(now.toISOString()) as RunRow[]
    ).map(toRun);
  }

  /**
   * Unfinished runs of threads whose deadline is at or before `now` (issue #21), oldest first:
   * the scheduler tick cancels them. Deadlines are stored as canonical UTC ISO text, so they
   * compare as text.
   */
  listUnfinishedPastDeadline(now: Date = new Date()): RunRecord[] {
    const statuses = ALL_STATUSES.filter((s) => !isTerminal(s));
    const placeholders = statuses.map(() => "?").join(", ");
    return (
      this.db
        .prepare(
          `SELECT r.* FROM runs r JOIN threads t ON t.id = r.thread_id
           WHERE t.deadline IS NOT NULL AND t.deadline <= ? AND r.status IN (${placeholders})
           ORDER BY r.created_at, r.id`,
        )
        .all(now.toISOString(), ...statuses) as RunRow[]
    ).map(toRun);
  }

  /** Runs whose sidecar may still be alive, for the scheduler to reconcile after a restart. */
  listActive(): RunRecord[] {
    const placeholders = LANE_HOLDING_STATUSES.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT * FROM runs WHERE status IN (${placeholders}) ORDER BY created_at`)
      .all(...LANE_HOLDING_STATUSES) as RunRow[];
    return rows.map(toRun);
  }

  /** Runs in any of `statuses`, oldest first; the stall sweep reads `running` and `stalled`. */
  listWithStatus(statuses: readonly RunStatus[]): RunRecord[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT * FROM runs WHERE status IN (${placeholders}) ORDER BY created_at, id`)
      .all(...statuses) as RunRow[];
    return rows.map(toRun);
  }

  /**
   * Moves the run to `to`, rejecting anything the contracts state machine forbids.
   * Terminal states stamp `finished_at`; `running` stamps `started_at` on first entry.
   */
  transition(
    id: RunId,
    to: RunStatus,
    patch: {
      sdkSessionId?: string;
      resumePayload?: RunResumePayload;
      summary?: RunSummary;
      error?: string;
      deliveredSeq?: number;
      /** Bumped by one on every resume; the dedup key for the resumed process's events. */
      attempt?: number;
      /** A resume restamps `started_at`; without it the row keeps the first process's start. */
      startedAt?: string;
    } = {},
  ): RunRecord {
    return this.db.transaction(() => {
      const run = this.mustGet(id);
      if (!canTransition(run.status, to)) {
        throw new DeskmatesError(
          "invalid_transition",
          `run ${id} cannot go from ${run.status} to ${to}`,
          {
            runId: id,
            from: run.status,
            to,
          },
        );
      }
      const ts = nowIso();
      this.db
        .prepare(
          `UPDATE runs SET status = ?,
             attempt = coalesce(?, attempt),
             started_at = CASE
               WHEN ? IS NOT NULL THEN ?
               WHEN ? = 'running' AND started_at IS NULL THEN ?
               ELSE started_at END,
             finished_at = CASE WHEN ? THEN ? ELSE finished_at END,
             sdk_session_id = coalesce(?, sdk_session_id),
             resume_payload_json = coalesce(?, resume_payload_json),
             summary_json = coalesce(?, summary_json),
             error = coalesce(?, error),
             delivered_seq = coalesce(?, delivered_seq)
           WHERE id = ?`,
        )
        .run(
          to,
          patch.attempt ?? null,
          patch.startedAt ?? null,
          patch.startedAt ?? null,
          to,
          ts,
          isTerminal(to) ? 1 : 0,
          ts,
          patch.sdkSessionId ?? null,
          patch.resumePayload ? JSON.stringify(patch.resumePayload) : null,
          patch.summary ? JSON.stringify(patch.summary) : null,
          patch.error ?? null,
          patch.deliveredSeq ?? null,
          id,
        );
      return this.mustGet(id);
    })();
  }

  /**
   * Merge keys into `runs.config_json`. The row is created before the scheduler resolves what the
   * run will actually be started with, so the knobs that are only known at start — the effective
   * model, with the bot's override applied — are merged here rather than at create. Existing keys
   * are overwritten, absent ones left alone, and nothing else on the row is touched.
   */
  setConfig(id: RunId, patch: Record<string, unknown>): RunRecord {
    return this.db.transaction(() => {
      const run = this.mustGet(id);
      const config = { ...run.config, ...patch };
      this.db
        .prepare("UPDATE runs SET config_json = ? WHERE id = ?")
        .run(JSON.stringify(config), id);
      return this.mustGet(id);
    })();
  }

  setDeliveredSeq(id: RunId, seq: number): void {
    this.db.prepare("UPDATE runs SET delivered_seq = ? WHERE id = ?").run(seq, id);
  }
}

function toRun(row: RunRow): RunRecord {
  const run: RunRecord = {
    id: row.id as RunId,
    botId: row.bot_id as BotId,
    lane: row.lane,
    triggerKind: row.trigger_kind,
    triggerRef: row.trigger_ref,
    status: row.status,
    attempt: row.attempt,
    createdAt: row.created_at,
    config: parseJson<Record<string, unknown>>(row.config_json, {}),
  };
  if (row.thread_id !== null) run.threadId = row.thread_id as ThreadId;
  if (row.sdk_session_id !== null) run.sdkSessionId = row.sdk_session_id;
  if (row.resume_payload_json !== null) {
    run.resumePayload = parseJson<RunResumePayload>(row.resume_payload_json, {
      sdkSessionId: "",
    });
  }
  if (row.trigger_payload_json !== null) {
    run.triggerPayload = parseJson<Record<string, unknown>>(row.trigger_payload_json, {});
  }
  if (row.delivered_seq !== null) run.deliveredSeq = row.delivered_seq;
  if (row.error !== null) run.error = row.error;
  if (row.started_at !== null) run.startedAt = row.started_at;
  if (row.finished_at !== null) run.finishedAt = row.finished_at;
  if (row.summary_json !== null) {
    run.summary = parseJson<RunSummary>(row.summary_json, {
      done: "",
      filesChanged: [],
      sitesVisited: [],
      pendingApprovals: [],
      memorySuggestions: [],
      reply: "",
    });
  }
  return run;
}
