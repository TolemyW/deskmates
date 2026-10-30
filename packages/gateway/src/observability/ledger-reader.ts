// Reads the ledger past the collector's cursor and turns what it finds into obs rows with their
// derived columns (ADR-0046 decisions 1 and 2). One call is one short read transaction on the
// Gateway's own connection, so every source is read from the same snapshot. It never writes.
//
// See `cursor.ts` for the three kinds of source. Two read rules keep a row from being emitted
// before it is final:
// - keyset sources read only rows changed more than `SETTLE_MS` ago, so two writes in the same
//   millisecond are both visible before the keyset passes them;
// - a model request is final once its usage landed, it was refused, its run left the live
//   statuses, or `REQUEST_SETTLE_MS` passed; a usage row once its run left the live statuses or
//   moved to a later attempt.

import { createHash } from "node:crypto";
import {
  OBSERVABILITY_TABLE_COLUMNS,
  type ObservabilityPayloadPolicy,
  type ObservabilityRow,
  type ObservabilityTable,
  type ObservabilityValue,
  type RunStatus,
  isTerminal,
} from "@deskmates/contracts";
import type { GatewayDb } from "../db/open.js";
import { classifyFailure } from "../ledger/failure-class.js";
import type { CollectorCursor, IdCursor, Keyset, Seen } from "./cursor.js";
import { PAYLOAD_SQL, shapePayload, shapeText } from "./payload-policy.js";

export const SETTLE_MS = 2000;
export const REQUEST_SETTLE_MS = 15 * 60 * 1000;
/** Run statuses in which a run's process may still write its usage and requests. */
const LIVE_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "stalled",
  "waiting_approval_live",
]);
/** Every status a run can leave again, as an `IN` list so `runs_status_created` serves it. */
const OPEN_STATUSES = (
  [
    "queued",
    "running",
    "stalled",
    "waiting_approval_live",
    "waiting_approval",
    "waiting_browser",
    "waiting_continuation",
    "waiting_platform",
  ] as const satisfies readonly RunStatus[]
).filter((status) => !isTerminal(status));
const OPEN_SQL = `(${OPEN_STATUSES.map((status) => `'${status}'`).join(", ")})`;

export interface ReadOptions {
  now: Date;
  payloads: ObservabilityPayloadPolicy;
  /** Rows per source per read. */
  pageSize?: number;
}

export type ObsRows = Partial<Record<ObservabilityTable, ObservabilityRow[]>>;

export interface ReadResult {
  rows: ObsRows;
  cursor: CollectorCursor;
  /** Some source returned a full page: read again before waiting. */
  more: boolean;
}

type Raw = Record<string, unknown>;

const DEFAULT_PAGE = 500;

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Milliseconds from `from` to `to`, or null when either is missing or unreadable. */
export function msBetween(from: unknown, to: unknown): number | null {
  if (typeof from !== "string" || typeof to !== "string") return null;
  const a = Date.parse(from);
  const b = Date.parse(to);
  return Number.isFinite(a) && Number.isFinite(b) ? b - a : null;
}

function rowOf(table: ObservabilityTable, values: Record<string, unknown>): ObservabilityRow {
  return OBSERVABILITY_TABLE_COLUMNS[table].map(([name]) => {
    const v = values[name];
    if (v === undefined || v === null) return null;
    if (typeof v === "boolean") return v ? 1 : 0;
    return v as ObservabilityValue;
  });
}

function fingerprint(row: ObservabilityRow, skip: number): string {
  return createHash("sha256")
    .update(JSON.stringify(skip >= 0 ? row.filter((_, i) => i !== skip) : row))
    .digest("hex")
    .slice(0, 16);
}

const OBSERVED_AT = 0; // `observed_at` is the first column of every snapshot table.

function keysetWhere(at: string, id: string): string {
  return `(${at} > @at OR (${at} = @at AND ${id} > @id))`;
}

function parsePayload(text: string): Raw {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Raw) : {};
  } catch {
    return {};
  }
}

export class LedgerReader {
  constructor(private readonly db: GatewayDb) {}

  read(start: CollectorCursor, opts: ReadOptions): ReadResult {
    return this.db.transaction(() => this.readAll(start, opts))();
  }

  private readAll(start: CollectorCursor, opts: ReadOptions): ReadResult {
    const cursor = structuredClone(start);
    const page = opts.pageSize ?? DEFAULT_PAGE;
    const rows: ObsRows = {};
    let more = false;
    const push = (table: ObservabilityTable, out: ObservabilityRow[], full: boolean) => {
      if (out.length) rows[table] = out;
      if (full) more = true;
    };
    const observedAt = opts.now.toISOString();
    const settleBefore = new Date(opts.now.getTime() - SETTLE_MS).toISOString();

    {
      const r = this.runEvents(cursor.run_events, page, opts.payloads);
      cursor.run_events = r.last;
      push("run_events", r.out, r.full);
    }
    {
      const r = this.runStates(cursor.run_states, page, observedAt, settleBefore);
      cursor.run_states = r.cursor;
      push("run_states", r.out, r.full);
    }
    for (const source of KEYSET_SOURCES) {
      const start = cursor[source.table] ?? null;
      const r = this.keyset(source, start, page, observedAt, settleBefore, opts);
      cursor[source.table] = r.key;
      push(source.table, r.out, r.full);
    }
    for (const source of SCAN_SOURCES) {
      const r = this.scan(source, cursor[source.table], observedAt);
      cursor[source.table] = r.seen;
      push(source.table, r.out, false);
    }
    {
      const r = this.modelRequests(cursor.model_requests, page, opts.now);
      cursor.model_requests = r.cursor;
      push("model_requests", r.out, r.full);
    }
    {
      const r = this.runUsage(cursor.run_usage, page);
      cursor.run_usage = r.cursor;
      push("run_usage", r.out, r.full);
    }
    {
      const raw = this.db
        .prepare(
          `SELECT tr.rowid AS rid, tr.task_id, tr.ordinal, tr.run_id, t.workspace_id
             FROM task_runs tr LEFT JOIN tasks t ON t.id = tr.task_id
            WHERE tr.rowid > ? ORDER BY tr.rowid LIMIT ?`,
        )
        .all(cursor.task_runs, page) as Raw[];
      if (raw.length) cursor.task_runs = raw[raw.length - 1]?.rid as number;
      push(
        "task_runs",
        raw.map((r) => rowOf("task_runs", r)),
        raw.length === page,
      );
    }
    return { rows, cursor, more };
  }

  private runEvents(after: number, page: number, payloads: ObservabilityPayloadPolicy) {
    const raw = this.db
      .prepare(
        `SELECT e.id, e.run_id, r.workspace_id, r.bot_id, e.attempt, e.seq, e.sidecar_seq, e.kind,
                e.source, e.ts, ${PAYLOAD_SQL} AS payload,
                length(CAST(e.payload_json AS BLOB)) AS bytes,
                t.private_to_user_id IS NOT NULL AS private
           FROM run_events e
           JOIN runs r ON r.id = e.run_id
           LEFT JOIN threads t ON t.id = r.thread_id
          WHERE e.id > ? ORDER BY e.id LIMIT ?`,
      )
      .all(after, page) as Raw[];
    const calls = new Map<string, { ts: string; name: string | null }>();
    const callOf = this.db.prepare(
      `SELECT ts, json_extract(payload_json, '$.toolName') AS name FROM run_events
        WHERE run_id = ? AND kind = 'tool_call' AND json_extract(payload_json, '$.toolUseId') = ?
        ORDER BY id LIMIT 1`,
    );
    const out = raw.map((e) => {
      const payload = parsePayload(e.payload as string);
      const kind = e.kind as string;
      const values: Record<string, unknown> = {
        event_id: e.id,
        run_id: e.run_id,
        workspace_id: e.workspace_id,
        bot_id: e.bot_id,
        attempt: e.attempt,
        seq: e.seq,
        sidecar_seq: e.sidecar_seq,
        kind,
        source: e.source,
        ts: e.ts,
        tool_use_id: str(payload.toolUseId),
      };
      const callKey = `${e.run_id as string}\u0000${str(payload.toolUseId) ?? ""}`;
      if (kind === "tool_call") {
        values.tool_name = str(payload.toolName);
        values.risk_level = str(payload.riskLevel);
        calls.set(callKey, { ts: e.ts as string, name: str(payload.toolName) });
      } else if (kind === "tool_result") {
        values.is_error = payload.isError === true;
        let call = calls.get(callKey);
        if (!call && typeof payload.toolUseId === "string") {
          const found = callOf.get(e.run_id, payload.toolUseId) as
            | { ts: string; name: unknown }
            | undefined;
          if (found) call = { ts: found.ts, name: str(found.name) };
        }
        if (call) {
          values.tool_name = call.name;
          values.duration_ms = msBetween(call.ts, e.ts);
        }
      } else if (kind === "turn_usage") {
        values.model = str(payload.model);
      } else if (kind === "model_switch") {
        values.model = str(payload.to);
      } else if (kind === "skill_used") {
        values.tool_name = str(payload.toolName);
      }
      if (payload.source === "phase_timing") {
        values.phase = str(payload.phase);
        values.span_id = str(payload.spanId);
        values.parent_span_id = str(payload.parentSpanId);
        values.edge = str(payload.edge);
        values.outcome = str(payload.outcome);
        values.request_kind = str(payload.requestKind);
        values.tool_name = str(payload.toolName);
        // A model proxy span names its request's model (ADR-0046 amendment 2 decision 21).
        values.model = str(payload.model);
        values.duration_ms = num(payload.durationMs);
      }
      const shaped = shapePayload(
        payloads,
        e.payload as string,
        e.bytes as number,
        e.private === 1,
      );
      values.payload_json = shaped.json;
      values.payload_bytes = shaped.bytes;
      values.payload_truncated = shaped.truncated;
      return rowOf("run_events", values);
    });
    return {
      out,
      last: raw.length ? (raw[raw.length - 1]?.id as number) : after,
      full: raw.length === page,
    };
  }

  private runStates(
    start: CollectorCursor["run_states"],
    page: number,
    observedAt: string,
    settleBefore: string,
  ) {
    const select = `SELECT id, workspace_id, bot_id, thread_id, lane, trigger_kind, run_type, status,
        attempt, json_extract(config_json, '$.model') AS model,
        json_extract(config_json, '$.cheapModel') AS cheap_model, error, created_at, started_at,
        finished_at FROM runs`;
    const key = start.key ?? { at: "", id: "" };
    const fresh = this.db
      .prepare(
        `${select} WHERE ${keysetWhere("created_at", "id")} AND created_at < @settle
          ORDER BY created_at, id LIMIT @page`,
      )
      .all({ ...key, settle: settleBefore, page }) as Raw[];
    const nextKey = fresh.length
      ? {
          at: fresh[fresh.length - 1]?.created_at as string,
          id: fresh[fresh.length - 1]?.id as string,
        }
      : start.key;
    // Runs before the keyset that are open now, or were open when last seen.
    const candidates = new Map<string, Raw>(fresh.map((r) => [r.id as string, r]));
    if (nextKey) {
      const open = this.db
        .prepare(
          `${select} WHERE status IN ${OPEN_SQL}
             AND (created_at < @at OR (created_at = @at AND id <= @id))`,
        )
        .all(nextKey) as Raw[];
      for (const r of open) candidates.set(r.id as string, r);
    }
    const missing = Object.keys(start.open).filter((id) => !candidates.has(id));
    const byId = this.db.prepare(`${select} WHERE id = ?`);
    const gone: string[] = [];
    for (const id of missing) {
      const r = byId.get(id) as Raw | undefined;
      if (r) candidates.set(id, r);
      else gone.push(id);
    }
    const open: Seen = { ...start.open };
    for (const id of gone) delete open[id];
    const out: ObservabilityRow[] = [];
    for (const r of candidates.values()) {
      const status = r.status as RunStatus;
      const terminal = isTerminal(status);
      const row = rowOf("run_states", {
        observed_at: observedAt,
        run_id: r.id,
        workspace_id: r.workspace_id,
        bot_id: r.bot_id,
        thread_id: r.thread_id,
        lane: r.lane,
        trigger_kind: r.trigger_kind,
        run_type: r.run_type,
        status,
        terminal,
        attempt: r.attempt,
        model: str(r.model),
        cheap_model: str(r.cheap_model),
        error: r.error,
        failure_class: classifyFailure(r.error as string | null) ?? null,
        created_at: r.created_at,
        started_at: r.started_at,
        finished_at: r.finished_at,
        queue_ms: msBetween(r.created_at, r.started_at),
        duration_ms:
          r.finished_at === null ? null : msBetween(r.started_at ?? r.created_at, r.finished_at),
      });
      const id = r.id as string;
      const fp = fingerprint(row, OBSERVED_AT);
      if (open[id] !== fp) out.push(row);
      if (terminal) delete open[id];
      else open[id] = fp;
    }
    return { out, cursor: { key: nextKey, open }, full: fresh.length === page };
  }

  private keyset(
    source: KeysetSource,
    start: Keyset | null,
    page: number,
    observedAt: string,
    settleBefore: string,
    opts: ReadOptions,
  ) {
    const raw = this.db
      .prepare(
        `${source.select} WHERE ${keysetWhere(source.at, source.id)} AND ${source.at} < @settle
          ${source.where ? `AND ${source.where}` : ""}
          ORDER BY ${source.at}, ${source.id} LIMIT @page`,
      )
      .all({ ...(start ?? { at: "", id: "" }), settle: settleBefore, page }) as Raw[];
    const last = raw[raw.length - 1];
    return {
      out: raw.map((r) => rowOf(source.table, source.values(r, observedAt, opts))),
      key: last ? { at: last.k_at as string, id: last.k_id as string } : start,
      full: raw.length === page,
    };
  }

  private scan(source: ScanSource, start: Seen, observedAt: string) {
    const seen: Seen = {};
    const out: ObservabilityRow[] = [];
    for (const r of this.db.prepare(source.select).all() as Raw[]) {
      const id = r.k_id as string;
      const row = rowOf(source.table, { ...r, observed_at: observedAt });
      const fp = fingerprint(row, OBSERVED_AT);
      seen[id] = fp;
      if (start[id] !== fp) out.push(row);
    }
    for (const id of Object.keys(start))
      if (!(id in seen)) out.push(rowOf(source.table, source.gone(id, observedAt)));
    return { out, seen };
  }

  /** Rows by id past `start`, emitting only settled ones; the id stops at the first unsettled. */
  private settledById(
    start: IdCursor,
    raw: Raw[],
    settled: (r: Raw) => boolean,
    page: number,
  ): { emit: Raw[]; cursor: IdCursor; full: boolean } {
    const ahead = new Set(start.ahead);
    let id = start.id;
    let blocked = false;
    const emit: Raw[] = [];
    const nextAhead: number[] = [];
    for (const r of raw) {
      const rowId = r.id as number;
      const already = ahead.has(rowId);
      const ok = already || settled(r);
      if (ok && !already) emit.push(r);
      if (!ok) blocked = true;
      else if (!blocked) id = rowId;
      else nextAhead.push(rowId);
    }
    // An `ahead` id the page did not reach stays ahead.
    const lastRead = raw.length ? (raw[raw.length - 1]?.id as number) : id;
    for (const a of start.ahead) if (a > lastRead) nextAhead.push(a);
    return {
      emit,
      cursor: { id, ahead: nextAhead.sort((a, b) => a - b) },
      // A full page that only re-read rows held behind an unsettled one is not a backlog: reading
      // it again before that row settles would find the same page.
      full: raw.length === page && (emit.length > 0 || id !== start.id),
    };
  }

  private modelRequests(start: IdCursor, page: number, now: Date) {
    const raw = this.db
      .prepare(
        `SELECT q.*, r.workspace_id, r.bot_id, r.status AS run_status FROM model_requests q
           LEFT JOIN runs r ON r.id = q.run_id
          WHERE q.id > ? ORDER BY q.id LIMIT ?`,
      )
      .all(start.id, page) as Raw[];
    const cutoff = now.getTime() - REQUEST_SETTLE_MS;
    const r = this.settledById(
      start,
      raw,
      (q) =>
        q.input_tokens !== null ||
        q.output_tokens !== null ||
        q.served_model !== null ||
        q.refusal !== null ||
        !LIVE_STATUSES.has(q.run_status as string) ||
        Date.parse(q.ts as string) < cutoff,
      page,
    );
    const out = r.emit.map((q) => {
      const counts = [q.input_tokens, q.cache_read_tokens, q.cache_create_tokens];
      const prompt = counts.some((c) => typeof c === "number")
        ? counts.reduce<number>((sum, c) => sum + (typeof c === "number" ? c : 0), 0)
        : null;
      return rowOf("model_requests", { ...q, request_id: q.id, prompt_tokens: prompt });
    });
    return { out, cursor: r.cursor, full: r.full };
  }

  private runUsage(start: IdCursor, page: number) {
    const raw = this.db
      .prepare(
        `SELECT u.*, r.workspace_id, r.bot_id, r.status AS run_status, r.attempt AS run_attempt
           FROM run_usage u LEFT JOIN runs r ON r.id = u.run_id
          WHERE u.id > ? ORDER BY u.id LIMIT ?`,
      )
      .all(start.id, page) as Raw[];
    const r = this.settledById(
      start,
      raw,
      (u) =>
        u.run_status === null ||
        !LIVE_STATUSES.has(u.run_status as string) ||
        (u.run_attempt as number) > (u.attempt as number),
      page,
    );
    return {
      out: r.emit.map((u) => rowOf("run_usage", { ...u, usage_id: u.id })),
      cursor: r.cursor,
      full: r.full,
    };
  }
}

interface KeysetSource {
  table:
    | "task_states"
    | "thread_states"
    | "run_summaries"
    | "approval_decisions"
    | "approval_requests";
  /** Must select `k_at` and `k_id`, the keyset columns, under those names. */
  select: string;
  at: string;
  id: string;
  where?: string;
  values(r: Raw, observedAt: string, opts: ReadOptions): Record<string, unknown>;
}

interface ScanSource {
  table: "bot_states" | "workspace_states" | "run_marks";
  /** Must select `k_id`, the row's key. */
  select: string;
  gone(id: string, observedAt: string): Record<string, unknown>;
}

/** `bot:x`, `human:y`, `rule:z`, `mode:approve_all`, `reviewer:...`: the part before the colon. */
function deciderKind(decidedBy: unknown): string | null {
  if (typeof decidedBy !== "string" || decidedBy === "") return null;
  const colon = decidedBy.indexOf(":");
  return colon > 0 ? decidedBy.slice(0, colon) : decidedBy;
}

const KEYSET_SOURCES: readonly KeysetSource[] = [
  {
    table: "task_states",
    select: "SELECT t.*, t.id AS task_id, t.updated_at AS k_at, t.id AS k_id FROM tasks t",
    at: "t.updated_at",
    id: "t.id",
    values: (r, observedAt) => ({
      ...r,
      observed_at: observedAt,
      delivery_ms: msBetween(r.created_at, r.delivered_at),
    }),
  },
  {
    table: "thread_states",
    select: `SELECT t.*, t.id AS thread_id, t.private_to_user_id IS NOT NULL AS private,
               t.updated_at AS k_at, t.id AS k_id FROM threads t`,
    at: "t.updated_at",
    id: "t.id",
    values: (r, observedAt) => ({
      ...r,
      observed_at: observedAt,
      title: r.private === 1 ? null : r.title,
    }),
  },
  {
    table: "run_summaries",
    select: `SELECT s.*, s.updated_at AS k_at, s.run_id || '/' || s.source_version AS k_id,
               th.private_to_user_id IS NOT NULL AS private
               FROM run_activity_summaries s
               LEFT JOIN runs r ON r.id = s.run_id
               LEFT JOIN threads th ON th.id = r.thread_id`,
    at: "s.updated_at",
    id: "s.run_id || '/' || s.source_version",
    values: (r, _observedAt, opts) => ({
      ...r,
      text: shapeText(opts.payloads, r.text as string | null, r.private === 1),
    }),
  },
  {
    table: "approval_decisions",
    select: `SELECT a.*, a.id AS approval_id, json_extract(a.action_json, '$.toolName') AS tool_name,
               a.decided_at AS k_at, a.id AS k_id FROM approvals a`,
    at: "a.decided_at",
    id: "a.id",
    where: "a.decision IS NOT NULL",
    values: (r) => ({
      ...r,
      tool_name: str(r.tool_name),
      decider_kind: deciderKind(r.decided_by),
      wait_ms: msBetween(r.created_at, r.decided_at),
    }),
  },
  {
    // Every approval once created, decided or not (amendment 2 decision 22): pending is a request
    // without a decision row. The row never changes, so it is emitted once.
    table: "approval_requests",
    select: `SELECT a.*, a.id AS approval_id, json_extract(a.action_json, '$.toolName') AS tool_name,
               a.created_at AS k_at, a.id AS k_id FROM approvals a`,
    at: "a.created_at",
    id: "a.id",
    values: (r) => ({ ...r, tool_name: str(r.tool_name) }),
  },
];

const SCAN_SOURCES: readonly ScanSource[] = [
  {
    table: "bot_states",
    select: `SELECT id AS bot_id, id AS k_id, workspace_id, name, role, model, cheap_model, runtime,
               soul_version, created_at, archived_at, paused_at, 0 AS deleted FROM bots`,
    gone: (id, observedAt) => ({ observed_at: observedAt, bot_id: id, deleted: 1 }),
  },
  {
    table: "workspace_states",
    select: `SELECT id AS workspace_id, id AS k_id, tenant_id, name, status, approval_mode,
               created_at, archived_at, 0 AS deleted FROM workspaces`,
    gone: (id, observedAt) => ({ observed_at: observedAt, workspace_id: id, deleted: 1 }),
  },
  {
    table: "run_marks",
    select: `SELECT run_id, run_id AS k_id, workspace_id, verdict, note, marked_by, marked_at
               FROM run_marks`,
    gone: (id, observedAt) => ({ observed_at: observedAt, run_id: id, verdict: "unmarked" }),
  },
];
