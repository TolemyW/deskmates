// Run events: the append-only per-run log. `seq` is assigned here, in arrival order, for every
// event whether the sidecar or the Gateway produced it, so the two sources never collide. The
// sidecar's own counter is kept as `sidecar_seq` for one purpose: a redelivered event (same run,
// same attempt, same sidecar seq) is dropped instead of stored twice. A resumed run is a second
// sidecar process whose counter restarts at 1, so the dedup key carries `attempt` too (ADR-0002
// amendment 2, "resume keeps the ledger whole"). Every stored event is handed to `onAppend` so
// SSE clients see Gateway and sidecar events alike.

import type { RunEvent, RunEventKind, RunId, ThreadId } from "@deskmates/contracts";
import { nowIso, parseJson } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";

interface EventRow {
  run_id: string;
  seq: number;
  sidecar_seq: number | null;
  attempt: number;
  kind: RunEventKind;
  payload_json: string;
  ts: string;
}

export interface AppendEventInput {
  runId: RunId;
  kind: RunEventKind;
  payload: Record<string, unknown>;
  /** SDK-host seq. Omitted for Gateway events and independently identified MCP timing spans. */
  seq?: number;
  /**
   * Which sidecar process of the run produced it. Omitted for a Gateway-originated event, which
   * is stamped with the run's current attempt instead.
   */
  attempt?: number;
  ts?: string;
}

export type EventAppended = (event: RunEvent, threadId: ThreadId | undefined) => void;

export class EventStore {
  constructor(
    private readonly db: GatewayDb,
    private readonly onAppend: EventAppended = () => {},
  ) {}

  /** Returns the stored event, or undefined when the input was a redelivery. */
  append(input: AppendEventInput): RunEvent | undefined {
    const stored = this.db.transaction(() => {
      // A Gateway-originated event (`resumed`, `decided`, a rule change) belongs to whichever
      // process of the run is current, so the ledger agrees with itself after a resume
      // (ADR-0002 amendment 2, "resume keeps the ledger whole").
      const attempt = input.attempt ?? this.currentAttempt(input.runId);
      if (input.seq !== undefined) {
        const dup = this.db
          .prepare("SELECT 1 FROM run_events WHERE run_id = ? AND attempt = ? AND sidecar_seq = ?")
          .get(input.runId, attempt, input.seq);
        if (dup !== undefined) return undefined;
      }
      const { max } = this.db
        .prepare("SELECT coalesce(max(seq), 0) AS max FROM run_events WHERE run_id = ?")
        .get(input.runId) as { max: number };
      const seq = max + 1;
      const ts = input.ts ?? nowIso();
      this.db
        .prepare(
          "INSERT INTO run_events (run_id, seq, sidecar_seq, attempt, kind, payload_json, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          input.runId,
          seq,
          input.seq ?? null,
          attempt,
          input.kind,
          JSON.stringify(input.payload),
          ts,
        );
      const event: RunEvent = {
        runId: input.runId,
        seq,
        attempt,
        kind: input.kind,
        payload: input.payload,
        ts,
      };
      if (input.seq !== undefined) event.sidecarSeq = input.seq;
      return event;
    })();
    if (stored) this.onAppend(stored, this.threadOf(input.runId));
    return stored;
  }

  /** Appends several events; returns the ones actually stored. */
  appendMany(inputs: readonly AppendEventInput[]): RunEvent[] {
    const out: RunEvent[] = [];
    for (const i of inputs) {
      const e = this.append(i);
      if (e) out.push(e);
    }
    return out;
  }

  list(runId: RunId, afterSeq = 0): RunEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq")
      .all(runId, afterSeq) as EventRow[];
    return rows.map(toEvent);
  }

  /**
   * A bounded slice of a run's events, always in `seq` order (#113 slice R). With `afterSeq` it
   * is the tail after that seq (oldest first); otherwise the newest events before `beforeSeq`
   * (or the newest of all). `more` says whether the slice stopped short: further events after it
   * for a tail, older events before it for a window. Reads `limit + 1` rows.
   */
  listSlice(
    runId: RunId,
    slice: { afterSeq?: number; beforeSeq?: number; limit: number },
  ): { events: RunEvent[]; more: boolean } {
    const limit = Math.trunc(slice.limit);
    if (slice.afterSeq !== undefined) {
      const rows = this.db
        .prepare("SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?")
        .all(runId, slice.afterSeq, limit + 1) as EventRow[];
      return { events: rows.slice(0, limit).map(toEvent), more: rows.length > limit };
    }
    const rows = this.db
      .prepare("SELECT * FROM run_events WHERE run_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?")
      .all(runId, slice.beforeSeq ?? Number.MAX_SAFE_INTEGER, limit + 1) as EventRow[];
    return { events: rows.slice(0, limit).reverse().map(toEvent), more: rows.length > limit };
  }

  /** The run's newest event of one kind, e.g. its latest screenshot (issue #9). */
  latestOfKind(runId: RunId, kind: RunEventKind): RunEvent | undefined {
    const row = this.db
      .prepare("SELECT * FROM run_events WHERE run_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1")
      .get(runId, kind) as EventRow | undefined;
    return row ? toEvent(row) : undefined;
  }

  /** The run's current sidecar process number; 1 when the run row has gone or never existed. */
  private currentAttempt(runId: RunId): number {
    const row = this.db.prepare("SELECT attempt FROM runs WHERE id = ?").get(runId) as
      | { attempt: number }
      | undefined;
    return row?.attempt ?? 1;
  }

  private threadOf(runId: RunId): ThreadId | undefined {
    const row = this.db.prepare("SELECT thread_id FROM runs WHERE id = ?").get(runId) as
      | { thread_id: string | null }
      | undefined;
    return row?.thread_id ? (row.thread_id as ThreadId) : undefined;
  }
}

function toEvent(r: EventRow): RunEvent {
  const event: RunEvent = {
    runId: r.run_id as RunId,
    seq: r.seq,
    attempt: r.attempt,
    kind: r.kind,
    payload: parseJson<Record<string, unknown>>(r.payload_json, {}),
    ts: r.ts,
  };
  if (r.sidecar_seq !== null) event.sidecarSeq = r.sidecar_seq;
  return event;
}
