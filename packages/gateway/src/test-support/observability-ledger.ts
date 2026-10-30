// T1 support for the observability tests (dev-only, imported by `*.test.ts` only): a ledger with
// one of everything the collector reads, a fake sink that keeps committed rows in memory and can
// fail midway, and helpers that compare what a sink holds with what the ledger holds.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OBSERVABILITY_CONTRACT_VERSION,
  OBSERVABILITY_TABLES,
  OBSERVABILITY_TABLE_COLUMNS,
  type ObservabilityBatch,
  type ObservabilityRow,
  type ObservabilitySinkRuntime,
  type ObservabilityTable,
  type RunId,
  observabilityCommitToken,
} from "@deskmates/contracts";
import { type Harness, startHarness } from "./harness.js";

export type Ctx = Harness["app"]["deskmates"]["ctx"];

export function tempDir(prefix: string): { dir: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A clock far enough ahead of the rows just written that every settle window has passed. */
export const LATER = () => new Date(Date.now() + 60_000);

export async function ledgerHarness(): Promise<{
  h: Harness;
  ctx: Ctx;
  botId: string;
  threadId: string;
  workspaceId: string;
}> {
  const h = await startHarness();
  h.app.deskmates.scheduler.stop();
  const { bot, thread, workspace } = await h.seed();
  return {
    h,
    ctx: h.app.deskmates.ctx,
    botId: bot.id,
    threadId: thread.id,
    workspaceId: workspace.id,
  };
}

let counter = 0;

/**
 * One finished run with a tool call and result, a phase-timing span, a screenshot, a turn's
 * usage, a model request with usage, a usage row, a decided approval, an Activity summary and a
 * task link. Returns its id.
 */
export function seedRun(
  ctx: Ctx,
  ids: { botId: string; threadId: string; workspaceId: string },
  status: "succeeded" | "failed" | "running" = "succeeded",
): RunId {
  counter++;
  const run = ctx.runs.create({
    botId: ids.botId as never,
    threadId: ids.threadId as never,
    lane: "interactive",
    triggerKind: "thread_message",
    triggerRef: `obs-test-${counter}`,
    config: { model: "model-a", cheapModel: "model-cheap" },
  });
  const at = new Date().toISOString();
  const toolUseId = `toolu_${counter}`;
  ctx.events.appendMany([
    {
      runId: run.id,
      kind: "tool_call",
      payload: {
        toolUseId,
        toolName: "browser_navigate",
        input: { url: "https://a.test" },
        riskLevel: "L0",
      },
    },
    {
      runId: run.id,
      kind: "log",
      payload: {
        source: "phase_timing",
        version: 1,
        spanId: `span-${counter}`,
        phase: "browser_rpc",
        edge: "end",
        at,
        durationMs: 42,
        outcome: "ok",
        toolName: "browser_navigate",
      },
    },
    {
      runId: run.id,
      kind: "tool_result",
      payload: { toolUseId, text: "page text", isError: false },
    },
    {
      runId: run.id,
      kind: "screenshot",
      payload: { base64: "A".repeat(4000), mimeType: "image/png", bytes: 3000, captureIndex: 1 },
    },
    {
      runId: run.id,
      kind: "turn_usage",
      payload: {
        model: "model-a",
        turn: 1,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
      },
    },
  ]);
  const request = ctx.modelRequests.insert({
    runId: run.id,
    attempt: 1,
    ts: at,
    requestKind: "messages",
    model: "model-a",
    stream: true,
  } as never);
  ctx.modelRequests.setUsage(request, {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 50,
  } as never);
  ctx.db
    .prepare(
      `INSERT INTO run_usage (run_id, attempt, model, input_tokens, output_tokens, cost_usd)
       VALUES (?, 1, 'model-a', 100, 20, 0.01)`,
    )
    .run(run.id);
  ctx.db
    .prepare(
      `INSERT INTO approvals (id, workspace_id, run_id, bot_id, thread_id, kind, action_json, risk_level,
         wait_mode, decision, decided_by, decided_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'tool', ?, 'L2', 'live', 'allow_once', 'human:web', ?, ?)`,
    )
    .run(
      `apr_obs_${counter}`,
      ids.workspaceId,
      run.id,
      ids.botId,
      ids.threadId,
      JSON.stringify({ toolName: "send_mail", input: {} }),
      new Date(Date.parse(at) + 1500).toISOString(),
      at,
    );
  ctx.db
    .prepare(
      `INSERT INTO run_activity_summaries (run_id, source_version, workspace_id, status, text, created_at, updated_at)
       VALUES (?, '1:done', ?, 'ready', 'Opened the page.', ?, ?)`,
    )
    .run(run.id, ids.workspaceId, at, at);
  const task = `task_obs_${counter}`;
  ctx.db
    .prepare(
      `INSERT INTO tasks (id, workspace_id, title, owner_bot_id, created_at, updated_at)
       VALUES (?, ?, 'Check the page', ?, ?, ?)`,
    )
    .run(task, ids.workspaceId, ids.botId, at, at);
  ctx.db
    .prepare("INSERT INTO task_runs (task_id, ordinal, run_id) VALUES (?, 1, ?)")
    .run(task, run.id);
  ctx.db
    .prepare("UPDATE runs SET status = ?, started_at = ?, finished_at = ?, error = ? WHERE id = ?")
    .run(
      status,
      at,
      status === "running" ? null : at,
      status === "failed" ? "upstream said model not found" : null,
      run.id,
    );
  return run.id;
}

/** Rows per table a sink holds, by table. */
export type SinkRows = Record<ObservabilityTable, ObservabilityRow[]>;

export function emptyRows(): SinkRows {
  return Object.fromEntries(OBSERVABILITY_TABLES.map((t) => [t, []])) as unknown as SinkRows;
}

/** An in-memory sink that honours commit tokens and can fail after `failAfterTables` tables. */
export function fakeSink(options: { failAfterTables?: number } = {}): ObservabilitySinkRuntime & {
  rows: SinkRows;
  tokens: Set<string>;
  writes: number;
  failNext(afterTables: number): void;
} {
  const rows = emptyRows();
  const tokens = new Set<string>();
  let failAfter = options.failAfterTables;
  const sink = {
    manifest: {
      id: "fake",
      version: "1",
      contractVersion: OBSERVABILITY_CONTRACT_VERSION,
      engine: "memory",
      capabilities: { vectors: false, dialect: "none" as const },
    },
    rows,
    tokens,
    writes: 0,
    failNext(afterTables: number) {
      failAfter = afterTables;
    },
    async ensureSchema() {},
    async writeBatch(batch: ObservabilityBatch) {
      sink.writes++;
      const committed: string[] = [];
      let n = 0;
      for (const table of OBSERVABILITY_TABLES) {
        const tableRows = batch.tables[table];
        if (!tableRows?.length) continue;
        if (failAfter !== undefined && n >= failAfter) {
          failAfter = undefined;
          throw new Error("fake sink failed between tables");
        }
        const token = observabilityCommitToken(table, batch.batchId);
        if (!tokens.has(token)) {
          for (const r of tableRows) rows[table].push(r);
          tokens.add(token);
        }
        committed.push(token);
        n++;
      }
      return { committed };
    },
    async lastCommitted() {
      const ids = [...tokens].map((t) => t.split("/")[2] ?? "");
      return ids.length ? ids.reduce((a, b) => (a > b ? a : b)) : null;
    },
    async close() {},
  };
  return sink;
}

/** The value of `column` in each row of `table`. */
export function column(rows: SinkRows, table: ObservabilityTable, name: string): unknown[] {
  const index = OBSERVABILITY_TABLE_COLUMNS[table].findIndex(([c]) => c === name);
  if (index < 0) throw new Error(`${table} has no column ${name}`);
  return rows[table].map((r) => r[index]);
}

export function ledgerIds(ctx: Ctx, sql: string): number[] {
  return (ctx.db.prepare(sql).all() as Array<{ id: number }>).map((r) => r.id);
}

/**
 * Every fact row once, and no snapshot repeated without a change. Returns the problems found, so
 * a test failure names them.
 */
export function exactlyOnceProblems(ctx: Ctx, rows: SinkRows): string[] {
  const problems: string[] = [];
  const once = (table: ObservabilityTable, idColumn: string, sql: string) => {
    const got = column(rows, table, idColumn) as number[];
    const want = ledgerIds(ctx, sql);
    const dups = got.filter((id, i) => got.indexOf(id) !== i);
    if (dups.length) problems.push(`${table} duplicated ${dups.join(",")}`);
    const lost = want.filter((id) => !got.includes(id));
    if (lost.length) problems.push(`${table} lost ${lost.join(",")}`);
  };
  once("run_events", "event_id", "SELECT id FROM run_events ORDER BY id");
  once("model_requests", "request_id", "SELECT id FROM model_requests ORDER BY id");
  // A usage row of a run still live in that attempt is not final yet, and is held back.
  once(
    "run_usage",
    "usage_id",
    `SELECT u.id FROM run_usage u JOIN runs r ON r.id = u.run_id
      WHERE r.status NOT IN ('queued', 'running', 'stalled', 'waiting_approval_live')
         OR r.attempt > u.attempt ORDER BY u.id`,
  );
  const snapshots: Array<[ObservabilityTable, string]> = [
    ["run_states", "run_id"],
    ["bot_states", "bot_id"],
    ["workspace_states", "workspace_id"],
    ["thread_states", "thread_id"],
    ["task_states", "task_id"],
    ["run_marks", "run_id"],
  ];
  for (const [table, key] of snapshots) {
    const keyIndex = OBSERVABILITY_TABLE_COLUMNS[table].findIndex(([c]) => c === key);
    const last = new Map<unknown, string>();
    for (const r of rows[table]) {
      const body = JSON.stringify(r.slice(1));
      if (last.get(r[keyIndex]) === body) problems.push(`${table} repeated ${String(r[keyIndex])}`);
      last.set(r[keyIndex], body);
    }
  }
  const runStatus = new Map<unknown, unknown>();
  const statusIndex = OBSERVABILITY_TABLE_COLUMNS.run_states.findIndex(([c]) => c === "status");
  for (const r of rows.run_states) runStatus.set(r[1], r[statusIndex]);
  for (const run of ctx.db.prepare("SELECT id, status FROM runs").all() as Array<{
    id: string;
    status: string;
  }>)
    if (runStatus.get(run.id) !== run.status)
      problems.push(
        `run_states ${run.id} ends ${String(runStatus.get(run.id))}, ledger ${run.status}`,
      );
  const approvals = column(rows, "approval_decisions", "approval_id");
  const decided = (
    ctx.db.prepare("SELECT id FROM approvals WHERE decision IS NOT NULL").all() as Array<{
      id: string;
    }>
  ).map((r) => r.id);
  if (approvals.length !== decided.length || decided.some((id) => !approvals.includes(id)))
    problems.push(`approval_decisions ${approvals.length} rows for ${decided.length} decided`);
  const links = rows.task_runs.length;
  const ledgerLinks = (ctx.db.prepare("SELECT count(*) AS n FROM task_runs").get() as { n: number })
    .n;
  if (links !== ledgerLinks) problems.push(`task_runs ${links} rows for ${ledgerLinks} links`);
  return problems;
}
