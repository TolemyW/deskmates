// `gateway_starts`: one row per Gateway process start (ADR-0029). The restart breaker counts them
// (decision 6), and the previous row's `last_seen_at` is when the previous Gateway was last alive,
// which names the cron minutes nobody fired while it was stopped (decision 11). `gateway_drains`:
// one row per drain, for the campaign measures of decision 13.

import type { GatewayDb } from "../db/open.js";

export interface GatewayStart {
  id: number;
  startedAt: string;
  lastSeenAt: string;
  release?: string;
}

interface Row {
  id: number;
  started_at: string;
  last_seen_at: string;
  release: string | null;
}

function toStart(row: Row): GatewayStart {
  return {
    id: row.id,
    startedAt: row.started_at,
    lastSeenAt: row.last_seen_at,
    ...(row.release === null ? {} : { release: row.release }),
  };
}

export class GatewayStartStore {
  constructor(private readonly db: GatewayDb) {}

  /** Records this process's start; returns it and the start before it, if any. */
  record(now: Date, release?: string): { current: GatewayStart; previous?: GatewayStart } {
    return this.db.transaction(() => {
      const previous = this.db
        .prepare("SELECT * FROM gateway_starts ORDER BY id DESC LIMIT 1")
        .get() as Row | undefined;
      const ts = now.toISOString();
      const info = this.db
        .prepare("INSERT INTO gateway_starts (started_at, last_seen_at, release) VALUES (?, ?, ?)")
        .run(ts, ts, release ?? null);
      const current: GatewayStart = {
        id: Number(info.lastInsertRowid),
        startedAt: ts,
        lastSeenAt: ts,
        ...(release === undefined ? {} : { release }),
      };
      return previous ? { current, previous: toStart(previous) } : { current };
    })();
  }

  /** This process is alive at `now`; the next start reads it as when this one stopped. */
  touch(id: number, now: Date): void {
    this.db
      .prepare("UPDATE gateway_starts SET last_seen_at = ? WHERE id = ? AND last_seen_at < ?")
      .run(now.toISOString(), id, now.toISOString());
  }

  /** Decision 1: a drain began; returns its row id. */
  drainStarted(now: Date, release?: string): number {
    const info = this.db
      .prepare("INSERT INTO gateway_drains (started_at, release) VALUES (?, ?)")
      .run(now.toISOString(), release ?? null);
    return Number(info.lastInsertRowid);
  }

  /** Decision 3: the drain was ended unforced, so the Gateway launches again. */
  drainEnded(id: number, now: Date): void {
    this.db
      .prepare("UPDATE gateway_drains SET ended_at = ? WHERE id = ? AND ended_at IS NULL")
      .run(now.toISOString(), id);
  }

  /** How many starts were recorded at or after `since`. */
  countSince(since: Date): number {
    const row = this.db
      .prepare("SELECT count(*) AS n FROM gateway_starts WHERE started_at >= ?")
      .get(since.toISOString()) as { n: number };
    return row.n;
  }
}
