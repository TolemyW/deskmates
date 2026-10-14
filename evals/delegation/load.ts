// Reads the rows `metrics.ts` needs out of a Gateway SQLite file. Read-only by construction: the
// six statements are SELECTs and the CLI opens the file with `readonly: true`, so pointing the
// script at a production ledger copies nothing and migrates nothing.

import type { Ledger, LedgerRunStatus } from "./metrics.js";

/** The slice of better-sqlite3's `Database` this needs; the gateway's own handle satisfies it. */
export interface ReadableDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

interface RunRow {
  id: string;
  bot_id: string;
  thread_id: string | null;
  trigger_kind: string;
  trigger_ref: string;
  status: LedgerRunStatus;
  delivered_seq: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface MessageRow {
  id: string;
  thread_id: string;
  seq: number;
  author_kind: "human" | "bot" | "system";
  author_id: string;
  mentions_json: string;
  run_id: string | null;
  ts: string;
  notice: number;
}

interface EventRow {
  run_id: string;
  kind: string;
  payload_json: string;
  ts: string;
}

interface UsageRow {
  run_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_create_tokens: number;
}

interface BotRow {
  id: string;
  name: string;
}

interface ThreadRow {
  id: string;
  kind: "chat" | "bus";
  members: number;
}

function mentionsEveryone(json: string): boolean {
  try {
    const parsed: unknown = JSON.parse(json);
    return (
      Array.isArray(parsed) &&
      parsed.some(
        (m: unknown) =>
          m !== null && typeof m === "object" && (m as { kind?: unknown }).kind === "everyone",
      )
    );
  } catch {
    return false;
  }
}

/** The bot ids of the explicit mentions in a `mentions_json` value; anything else is none. */
function botMentions(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((m: unknown) => {
      if (m === null || typeof m !== "object") return [];
      const mention = m as { kind?: unknown; botId?: unknown };
      return mention.kind === "bot" && typeof mention.botId === "string" ? [mention.botId] : [];
    });
  } catch {
    return [];
  }
}

export function loadLedger(db: ReadableDb): Ledger {
  const runs = db
    .prepare(
      `SELECT id, bot_id, thread_id, trigger_kind, trigger_ref, status, delivered_seq,
              created_at, started_at, finished_at
         FROM runs ORDER BY created_at, id`,
    )
    .all() as RunRow[];
  const messages = db
    .prepare(
      `SELECT id, thread_id, seq, author_kind, author_id, mentions_json, run_id, ts,
              (author_kind = 'system' AND body LIKE 'Delegation outcome:%') AS notice
         FROM thread_messages ORDER BY ts, seq`,
    )
    .all() as MessageRow[];
  // Only the events the metrics read; a ledger has many thousands of tool events per run.
  const events = db
    .prepare(
      `SELECT run_id, kind, payload_json, ts FROM run_events
        WHERE kind = 'log' AND json_extract(payload_json, '$.source') = 'delegation_outcome'
        ORDER BY id`,
    )
    .all() as EventRow[];
  const usage = db
    .prepare(
      "SELECT run_id, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens FROM run_usage",
    )
    .all() as UsageRow[];
  const bots = db.prepare("SELECT id, name FROM bots").all() as BotRow[];
  const threads = db
    .prepare(
      `SELECT t.id, t.kind,
              (SELECT count(*) FROM thread_members m WHERE m.thread_id = t.id) AS members
         FROM threads t ORDER BY t.created_at, t.id`,
    )
    .all() as ThreadRow[];
  return {
    threads: threads.map((t) => ({ id: t.id, kind: t.kind, members: t.members })),
    runs: runs.map((r) => ({
      id: r.id,
      botId: r.bot_id,
      threadId: r.thread_id,
      triggerKind: r.trigger_kind,
      triggerRef: r.trigger_ref,
      status: r.status,
      deliveredSeq: r.delivered_seq,
      createdAt: r.created_at,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
    })),
    messages: messages.map((m) => ({
      id: m.id,
      threadId: m.thread_id,
      seq: m.seq,
      authorKind: m.author_kind,
      authorId: m.author_id,
      mentions: botMentions(m.mentions_json),
      everyone: mentionsEveryone(m.mentions_json),
      notice: m.notice === 1,
      runId: m.run_id,
      ts: m.ts,
    })),
    events: events.map((e) => {
      let payload: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(e.payload_json);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
          payload = parsed as Record<string, unknown>;
      } catch {
        /* An unreadable payload is an event with no fields; the row still counts as a notice. */
      }
      return { runId: e.run_id, kind: e.kind, payload, ts: e.ts };
    }),
    usage: usage.map((u) => ({
      runId: u.run_id,
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cacheReadTokens: u.cache_read_tokens,
      cacheCreateTokens: u.cache_create_tokens,
    })),
    bots: bots.map((b) => ({ id: b.id, name: b.name })),
  };
}
