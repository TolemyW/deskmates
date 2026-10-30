// T1 (ADR-0050 decisions 2 to 6): the bot's own `run_stats` answer through the run-token route,
// scoped to the run's bot in the run's workspace whatever the request says; counts, failure
// classes and durations per window; spend as Costs prices it with unpriced usage kept unpriced;
// no run text; no model call; and the per-bot switch, off by default and audited.

import type {
  BotId,
  BotRunStatsSetting,
  RunId,
  RunStatsReport,
  Workspace,
} from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "../test-support/harness.js";

const DAY = 86_400_000;
let h: Harness;
let seq = 0;

beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

const db = () => h.app.deskmates.ctx.db;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

interface RunSeed {
  status?: string;
  lane?: "interactive" | "background";
  error?: string;
  daysAgo?: number;
  seconds?: number;
  threadId?: string;
  config?: Record<string, unknown>;
  summary?: Record<string, unknown>;
}

function insertRun(workspaceId: string, botId: string, seed: RunSeed = {}): RunId {
  const id = `run_stats_${++seq}`;
  const created = (seed.daysAgo ?? 1) * DAY;
  const finished = seed.seconds === undefined ? null : iso(created - seed.seconds * 1000 - 1000);
  db()
    .prepare(
      `INSERT INTO runs (id, workspace_id, bot_id, thread_id, lane, trigger_kind, trigger_ref, status,
         config_json, summary_json, error, created_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, 'thread_message', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      workspaceId,
      botId,
      seed.threadId ?? null,
      seed.lane ?? "interactive",
      id,
      seed.status ?? "succeeded",
      JSON.stringify(seed.config ?? { runStats: "self-v1" }),
      seed.summary ? JSON.stringify(seed.summary) : null,
      seed.error ?? null,
      iso(created),
      iso(created - 1000),
      finished,
    );
  return id as RunId;
}

function insertUsage(runId: RunId, model: string, costUsd: number | null): void {
  db()
    .prepare(
      `INSERT INTO run_usage (run_id, attempt, model, input_tokens, output_tokens,
         cache_read_tokens, cache_create_tokens, cost_usd) VALUES (?, 1, ?, 100, 10, 5, 1, ?)`,
    )
    .run(runId, model, costUsd);
}

function insertApproval(workspaceId: string, botId: string, runId: RunId, decided = false) {
  const id = `apr_stats_${++seq}`;
  db()
    .prepare(
      `INSERT INTO approvals (id, workspace_id, run_id, bot_id, kind, action_json, risk_level,
         display_summary_json, wait_mode, decision, created_at)
       VALUES (?, ?, ?, ?, 'tool', ?, 'L2', ?, 'deferred', ?, ?)`,
    )
    .run(
      id,
      workspaceId,
      runId,
      botId,
      JSON.stringify({ toolName: "Bash", input: { command: "secret-approval-input" } }),
      JSON.stringify({ title: "secret-approval-summary" }),
      decided ? "deny" : null,
      iso(DAY),
    );
  return id;
}

function insertTask(workspaceId: string, botId: string, title: string, status = "in_progress") {
  const id = `task_stats_${++seq}`;
  db()
    .prepare(
      `INSERT INTO tasks (id, workspace_id, title, owner_bot_id, status, blocked_reason,
         next_action, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      workspaceId,
      title,
      botId,
      status,
      status === "blocked" ? "waiting" : "",
      status === "blocked" ? "ask" : "",
      iso(DAY),
      iso(DAY),
    );
  return id;
}

/** A person's private chat with the bot (ADR-0022 amendment 6). */
function privateChat(workspaceId: Workspace["id"], botId: BotId) {
  const at = new Date().toISOString();
  const userId = `usr_stats_${++seq}`;
  db()
    .prepare("INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, 'P', ?, ?)")
    .run(userId, at, at);
  const thread = h.app.deskmates.ctx.threads.create({ workspaceId, botIds: [botId] });
  db().prepare("UPDATE threads SET private_to_user_id = ? WHERE id = ?").run(userId, thread.id);
  return thread;
}

async function stats(runId: RunId, query = "", token?: string) {
  const res = await fetch(`${h.baseUrl}/internal/runs/${runId}/run-stats${query}`, {
    headers: {
      authorization: `Bearer ${token ?? h.app.deskmates.ctx.tokens.issue(runId).token}`,
    },
  });
  return { status: res.status, json: (await res.json()) as RunStatsReport & { code?: string } };
}

async function world() {
  const { workspace, bot } = await h.seed();
  const ctx = h.app.deskmates.ctx;
  const teammate = ctx.bots.create({ name: "bob", role: "peer", workspaceId: workspace.id });
  const other = (
    await h.api<{ workspace: Workspace }>("POST", "/api/workspaces", {
      defaultBot: false,
      name: "ws-2",
      egressAllowlist: ["*.example.test"],
    })
  ).json.workspace;
  const stranger = ctx.bots.create({ name: "alice", role: "peer", workspaceId: other.id });
  return { workspace, bot, teammate, other, stranger };
}

describe("run_stats route", () => {
  it("answers only the calling bot in its own workspace", async () => {
    const { workspace, bot, teammate, other, stranger } = await world();
    const mine = insertRun(workspace.id, bot.id);
    insertRun(workspace.id, bot.id, { status: "failed", error: "model not found" });
    const theirs = insertRun(workspace.id, teammate.id, { status: "failed", error: "x" });
    const far = insertRun(other.id, stranger.id, { status: "failed", error: "x" });
    for (const run of [mine, theirs, far]) insertUsage(run, "m", 1);
    insertApproval(workspace.id, teammate.id, theirs);
    insertApproval(other.id, stranger.id, far);
    insertTask(workspace.id, teammate.id, "teammate task");
    insertTask(other.id, stranger.id, "stranger task");
    insertRun(workspace.id, teammate.id, { status: "waiting_approval" });

    const { status, json } = await stats(mine);
    expect(status).toBe(200);
    expect(json).toMatchObject({ botId: bot.id, workspaceId: workspace.id, runId: mine });
    expect(json.current.runs).toBe(2);
    expect(json.current.byStatus).toEqual({ succeeded: 1, failed: 1 });
    expect(json.current.spend.knownCostUsd).toBe(1);
    expect(json.now.pendingApprovals.total).toBe(0);
    expect(json.now.parkedRuns.total).toBe(0);
    expect(json.now.tasks.open.total).toBe(0);
    const text = JSON.stringify(json);
    for (const id of [teammate.id, stranger.id, other.id, theirs, far])
      expect(text).not.toContain(id);
  });

  it("refuses crafted parameters and keeps the scope of the token's run", async () => {
    const { workspace, bot, teammate, other } = await world();
    const mine = insertRun(workspace.id, bot.id);
    insertRun(workspace.id, teammate.id);
    for (const query of [
      `?botId=${teammate.id}`,
      `?workspaceId=${other.id}`,
      `?windowDays=7&runId=${mine}`,
      "?windowDays=0",
      "?windowDays=31",
      "?windowDays=2.5",
      "?windowDays=-1",
    ]) {
      const res = await stats(mine, query);
      expect(res.status, query).toBe(400);
      expect(res.json.code).toBe("validation");
    }
    const ok = await stats(mine, "?windowDays=30");
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ botId: bot.id, windowDays: 30 });
    expect(ok.json.current.runs).toBe(1);
  });

  it("refuses another run's token, and a run that did not freeze run_stats", async () => {
    const { workspace, bot, teammate } = await world();
    const mine = insertRun(workspace.id, bot.id);
    const theirs = insertRun(workspace.id, teammate.id);
    const token = h.app.deskmates.ctx.tokens.issue(theirs).token;
    const wrong = await stats(mine, "", token);
    expect(wrong.status).toBe(401);
    expect(wrong.json.code).toBe("token_rejected");

    for (const config of [{ runStats: "off" }, {}]) {
      const off = insertRun(workspace.id, bot.id, { config });
      const refused = await stats(off);
      expect(refused.status).toBe(403);
      expect(refused.json.code).toBe("forbidden");
    }
  });

  it("counts runs, failure classes and durations per window", async () => {
    const { workspace, bot } = await world();
    const privateThread = privateChat(workspace.id, bot.id);
    const asking = insertRun(workspace.id, bot.id, { status: "running", daysAgo: 0 });
    insertRun(workspace.id, bot.id, { seconds: 10 });
    insertRun(workspace.id, bot.id, { status: "silent", seconds: 20, lane: "background" });
    insertRun(workspace.id, bot.id, {
      status: "failed",
      error: "model not found: cheap-1",
      seconds: 30,
    });
    insertRun(workspace.id, bot.id, { status: "failed", seconds: 40 });
    insertRun(workspace.id, bot.id, {
      status: "succeeded",
      seconds: 100,
      threadId: privateThread.id,
    });
    insertRun(workspace.id, bot.id, {
      status: "succeeded",
      seconds: 5,
      config: { runStats: "off", runType: "approval_presentation" },
    });
    // The previous window: two runs, one failed on the wall clock.
    insertRun(workspace.id, bot.id, { daysAgo: 10, seconds: 50 });
    insertRun(workspace.id, bot.id, { daysAgo: 10, status: "failed", error: "deadline" });
    // Outside both windows.
    insertRun(workspace.id, bot.id, { daysAgo: 20, status: "failed", error: "x" });

    const { json } = await stats(asking);
    expect(json.windowDays).toBe(7);
    expect(json.current).toMatchObject({
      runs: 7,
      byStatus: { running: 1, succeeded: 3, silent: 1, failed: 2 },
      byLane: { interactive: 6, background: 1 },
      failureClasses: { model_unavailable: 1, other: 1 },
      jobRuns: 1,
      privateChatRuns: 1,
    });
    expect(json.current.durations).toMatchObject({
      finished: 6,
    });
    expect(json.current.durations.medianSeconds).toBeCloseTo(20, 2);
    expect(json.current.durations.maxSeconds).toBeCloseTo(100, 2);
    expect(json.current.durations.totalSeconds).toBeCloseTo(205, 0);
    expect(json.previous.runs).toBe(2);
    expect(json.previous.byStatus).toEqual({ succeeded: 1, failed: 1 });
    expect(json.trend).toMatchObject({
      runs: 5,
      failed: 1,
      successShare: { current: 0.667, previous: 0.5 },
    });
    expect(json.now.executingRuns).toBe(1);
    expect(json.current.from <= json.current.to).toBe(true);
    expect(json.previous.to < json.current.from).toBe(true);
  });

  it("prices spend as Costs does and keeps unpriced usage unpriced", async () => {
    const { workspace, bot, teammate } = await world();
    const asking = insertRun(workspace.id, bot.id, { status: "running", daysAgo: 0 });
    const priced = insertRun(workspace.id, bot.id);
    const unpriced = insertRun(workspace.id, bot.id);
    insertUsage(priced, "model-a", 0.25);
    insertUsage(unpriced, "model-b", null);
    // The previous window has only unpriced usage: its known cost is unknown, not zero.
    insertUsage(insertRun(workspace.id, bot.id, { daysAgo: 10 }), "model-b", null);
    insertUsage(insertRun(workspace.id, teammate.id), "model-a", 5);

    const { json } = await stats(asking);
    expect(json.current.spend).toMatchObject({
      knownCostUsd: 0.25,
      estimatedCostUsd: null,
      costStatus: "partial",
      pricedUsageCount: 1,
      unpricedUsageCount: 1,
      inputTokens: 200,
    });
    expect(json.previous.spend).toMatchObject({
      knownCostUsd: null,
      costStatus: "unpriced",
      unpricedUsageCount: 1,
    });
    expect(json.trend.knownCostUsd).toBeNull();

    // The same figure the operator's Costs page reports for this bot.
    const costs = await h.api<{ totals: { knownCostUsd: number } }>(
      "GET",
      `/api/costs?workspaceId=${workspace.id}&botId=${bot.id}&from=${json.current.from}&to=${json.current.to}`,
    );
    expect(costs.json.totals.knownCostUsd).toBe(0.25);
  });

  it("lists pending approvals, parked runs and own tasks", async () => {
    const { workspace, bot } = await world();
    const asking = insertRun(workspace.id, bot.id, { status: "running", daysAgo: 0 });
    const parked = insertRun(workspace.id, bot.id, { status: "waiting_approval" });
    insertRun(workspace.id, bot.id, { status: "waiting_platform", lane: "background" });
    const pending = insertApproval(workspace.id, bot.id, parked);
    insertApproval(workspace.id, bot.id, parked, true);
    insertTask(workspace.id, bot.id, "Ship the report");
    insertTask(workspace.id, bot.id, "Wait for data", "blocked");
    insertTask(workspace.id, bot.id, "Old work", "cancelled");

    const { json } = await stats(asking);
    expect(json.now.pendingApprovals).toEqual({
      total: 1,
      items: [
        {
          approvalId: pending,
          runId: parked,
          kind: "tool",
          toolName: "Bash",
          waitingSince: expect.any(String),
        },
      ],
    });
    expect(json.now.parkedRuns.total).toBe(2);
    expect(json.now.parkedRuns.byStatus).toEqual({ waiting_approval: 1, waiting_platform: 1 });
    expect(json.now.parkedRuns.items.map((r) => r.runId)).toContain(parked);
    expect(json.now.tasks.byStatus).toEqual({ in_progress: 1, blocked: 1, cancelled: 1 });
    expect(json.now.tasks.open.total).toBe(2);
    expect(json.now.tasks.open.items.map((t) => t.title).sort()).toEqual([
      "Ship the report",
      "Wait for data",
    ]);
  });

  it("carries no run text and makes no model call", async () => {
    const { workspace, bot } = await world();
    const ctx = h.app.deskmates.ctx;
    const privateThread = privateChat(workspace.id, bot.id);
    ctx.messages.append({
      threadId: privateThread.id,
      authorKind: "human",
      authorId: "someone",
      body: "secret-private-message",
    });
    const asking = insertRun(workspace.id, bot.id, { status: "running", daysAgo: 0 });
    const failed = insertRun(workspace.id, bot.id, {
      status: "waiting_approval",
      threadId: privateThread.id,
      error: "secret-error-text",
      summary: { done: "secret-summary", reply: "secret-reply" },
    });
    insertApproval(workspace.id, bot.id, failed);
    const count = (table: string) =>
      (db().prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    const before = { runs: count("runs"), requests: count("model_requests") };

    const { status, json } = await stats(asking);
    expect(status).toBe(200);
    const text = JSON.stringify(json);
    for (const secret of [
      "secret-private-message",
      "secret-error-text",
      "secret-summary",
      "secret-reply",
      "secret-approval-input",
      "secret-approval-summary",
      privateThread.id,
    ])
      expect(text).not.toContain(secret);
    expect(json.now.pendingApprovals.total).toBe(1);
    expect({ runs: count("runs"), requests: count("model_requests") }).toEqual(before);
    expect(h.provider.execCalls).toHaveLength(0);
  });
});

describe("run_stats setting", () => {
  it("is off by default and set by an Owner or Admin, audited", async () => {
    const { bot } = await world();
    const path = `/api/bots/${bot.id}/run-stats`;
    const initial = await h.api<{ runStats: BotRunStatsSetting }>("GET", path);
    expect(initial.status).toBe(200);
    expect(initial.json.runStats).toEqual({ botId: bot.id, enabled: false });

    const on = await h.api<{ runStats: BotRunStatsSetting }>("PUT", path, { enabled: true });
    expect(on.status).toBe(200);
    expect(on.json.runStats).toMatchObject({ botId: bot.id, enabled: true });
    expect((await h.api<{ runStats: BotRunStatsSetting }>("GET", path)).json.runStats.enabled).toBe(
      true,
    );
    // Same value again: no second audit row.
    await h.api("PUT", path, { enabled: true });
    const off = await h.api<{ runStats: BotRunStatsSetting }>("PUT", path, { enabled: false });
    expect(off.json.runStats).toEqual({ botId: bot.id, enabled: false });

    const rows = db()
      .prepare(
        "SELECT before_json, after_json, target_id FROM audit_events WHERE action = 'bot.run_stats_set' ORDER BY seq",
      )
      .all() as { before_json: string; after_json: string; target_id: string }[];
    expect(rows.map((r) => [JSON.parse(r.before_json), JSON.parse(r.after_json)])).toEqual([
      [{ enabled: false }, { enabled: true }],
      [{ enabled: true }, { enabled: false }],
    ]);
    expect(rows.every((r) => r.target_id === bot.id)).toBe(true);

    for (const body of [{}, { enabled: "yes" }, { enabled: true, botId: "bot_x" }])
      expect((await h.api("PUT", path, body)).status).toBe(400);
    expect((await h.api("GET", "/api/bots/bot_missing/run-stats")).status).toBe(404);
  });

  it("is removed with its bot's workspace", async () => {
    const { bot, workspace } = await world();
    await h.api("PUT", `/api/bots/${bot.id}/run-stats`, { enabled: true });
    db().prepare("DELETE FROM workspaces WHERE id = ?").run(workspace.id);
    expect(
      db()
        .prepare("SELECT count(*) AS n FROM bot_run_stats WHERE bot_id = ?")
        .get(bot.id as BotId),
    ).toEqual({ n: 0 });
  });
});
