// T1, ADR-0042 decisions 2 to 4: the run list's audit filters compose in SQL and page; every run
// carries its failure class and mark; marking a run wrong makes its learned items do-not-learn
// for consolidation and for a run still going, and unmarking restores them; the changes route
// answers approvals, checkpoints, artifacts and memory written by one run.

import type { ApprovalId, BotId, RunId, StartRunRequest, WorkspaceId } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { MARKED_WRONG_REASON } from "../ledger/run-marks.js";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

interface ListedRun {
  id: RunId;
  status: string;
  failureClass?: string;
  mark?: { verdict: string; note?: string; markedBy: string };
}

async function setup() {
  h = await startHarness();
  h.app.deskmates.scheduler.stop();
  const seeded = await h.seed();
  return { h, ctx: h.app.deskmates.ctx, ...seeded };
}

/** A finished run with a fixed time, status, lane and error. */
function seedRun(
  harness: Harness,
  botId: BotId,
  opts: { at: string; status: string; lane?: "interactive" | "background"; error?: string },
): RunId {
  const ctx = harness.app.deskmates.ctx;
  const run = ctx.runs.create({
    botId,
    lane: opts.lane ?? "interactive",
    triggerKind: "cron",
    triggerRef: `cron:${opts.at}`,
  });
  ctx.db
    .prepare("UPDATE runs SET created_at = ?, finished_at = ?, status = ?, error = ? WHERE id = ?")
    .run(opts.at, opts.at, opts.status, opts.error ?? null, run.id);
  return run.id;
}

describe("run list audit filters (ADR-0042 decision 2)", () => {
  it("composes status, lane, time range, failure class and text, and pages the result", async () => {
    const { h, bot } = await setup();
    const dead = 'API Error: 503 {"error":{"message":"No worker available for model m"}}';
    const want: RunId[] = [];
    for (let i = 0; i < 25; i += 1)
      want.push(
        seedRun(h, bot.id, {
          at: new Date(Date.UTC(2026, 9, 10, 1, i)).toISOString(),
          status: "failed",
          lane: "background",
          error: dead,
        }),
      );
    // Each of these misses exactly one filter.
    seedRun(h, bot.id, {
      at: "2026-10-10T02:00:00.000Z",
      status: "failed",
      lane: "background",
      error: dead,
    });
    seedRun(h, bot.id, {
      at: "2026-10-09T23:00:00.000Z",
      status: "failed",
      lane: "background",
      error: dead,
    });
    seedRun(h, bot.id, {
      at: "2026-10-10T01:30:00.000Z",
      status: "failed",
      lane: "interactive",
      error: dead,
    });
    seedRun(h, bot.id, {
      at: "2026-10-10T01:31:00.000Z",
      status: "cancelled",
      lane: "background",
      error: dead,
    });
    seedRun(h, bot.id, {
      at: "2026-10-10T01:32:00.000Z",
      status: "failed",
      lane: "background",
      error: "model_not_found",
    });
    seedRun(h, bot.id, {
      at: "2026-10-10T01:33:00.000Z",
      status: "failed",
      lane: "background",
      error: "Claude Code process aborted by user",
    });

    const base = `/api/runs?botId=${bot.id}&status=failed&lane=background&since=2026-10-10T00:00:00Z&until=2026-10-10T02:00:00Z&failureClass=model_unavailable&q=WORKER`;
    const seen: ListedRun[] = [];
    let cursor: string | undefined;
    do {
      const page = await h.api<{ runs: ListedRun[]; nextCursor?: string }>(
        "GET",
        `${base}&limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      expect(page.status).toBe(200);
      seen.push(...page.json.runs);
      cursor = page.json.nextCursor;
    } while (cursor);
    expect(seen.map((r) => r.id).sort()).toEqual([...want].sort());
    expect(seen.every((r) => r.failureClass === "model_unavailable")).toBe(true);

    // A status list, and each class on its own.
    const both = await h.api<{ runs: ListedRun[] }>(
      "GET",
      `/api/runs?botId=${bot.id}&status=failed,cancelled&limit=100`,
    );
    expect(both.json.runs).toHaveLength(31);
    const aborts = await h.api<{ runs: ListedRun[] }>(
      "GET",
      `/api/runs?botId=${bot.id}&failureClass=sdk_abort`,
    );
    expect(aborts.json.runs.map((r) => r.failureClass)).toEqual(["sdk_abort"]);
  });

  it("refuses an unknown status, lane, class or time", async () => {
    const { h } = await setup();
    for (const query of ["status=done", "lane=side", "failureClass=bad", "since=yesterday"])
      expect((await h.api("GET", `/api/runs?${query}`)).status, query).toBe(400);
  });
});

describe("marking a run wrong (ADR-0042 decision 3)", () => {
  it("keeps the run's candidates out of consolidation while marked, and unmarking restores", async () => {
    const { h, ctx, bot, workspace } = await setup();
    const marked = seedRun(h, bot.id, { at: "2026-10-10T01:00:00.000Z", status: "succeeded" });
    const plain = seedRun(h, bot.id, { at: "2026-10-10T01:05:00.000Z", status: "succeeded" });
    const candidate = (runId: RunId, body: string) =>
      ctx.memory.entries.insert({
        workspaceId: workspace.id as WorkspaceId,
        scope: "bot",
        kind: "candidate",
        botId: bot.id,
        body,
        authority: "procedure",
        trust: "trusted",
        sourceKind: "bot_self",
        sourceRunId: runId,
        by: `bot:${bot.id}`,
      });
    const wrong = candidate(marked, "Always skip the review queue.");
    const right = candidate(plain, "Export the refund sheet before closing.");
    const inputIds = () =>
      ctx.memory.entries.consolidationInput(workspace.id as WorkspaceId, bot.id).map((e) => e.id);
    expect(inputIds()).toEqual([wrong.id, right.id]);

    const put = await h.api<{ mark: { verdict: string; note?: string; markedBy: string } }>(
      "PUT",
      `/api/runs/${marked}/mark`,
      { note: "it skipped review on purpose" },
    );
    expect(put.status).toBe(200);
    expect(put.json.mark).toMatchObject({ verdict: "wrong", note: "it skipped review on purpose" });
    expect(inputIds()).toEqual([right.id]);

    // A consolidation requested now takes nothing from the marked run.
    const consolidation = ctx.memory.consolidation.request(bot.id);
    expect(consolidation.config.consolidationSources).toEqual([right.id]);
    expect(JSON.stringify(consolidation.triggerPayload)).not.toContain("skip the review queue");

    // The mark is on the run everywhere the run list shows it.
    const listed = await h.api<{ runs: ListedRun[] }>("GET", `/api/runs?botId=${bot.id}`);
    expect(listed.json.runs.find((r) => r.id === marked)?.mark?.verdict).toBe("wrong");
    expect(listed.json.runs.find((r) => r.id === plain)?.mark).toBeUndefined();
    const changes = await h.api<{ mark?: { note?: string } }>("GET", `/api/runs/${marked}/changes`);
    expect(changes.json.mark?.note).toBe("it skipped review on purpose");

    const del = await h.api<{ removed: boolean }>("DELETE", `/api/runs/${marked}/mark`);
    expect(del.json.removed).toBe(true);
    expect(inputIds()).toEqual([wrong.id, right.id]);
    expect(
      (await h.api<{ removed: boolean }>("DELETE", `/api/runs/${marked}/mark`)).json.removed,
    ).toBe(false);
  });

  it("does not count a marked run's candidates toward an automatic consolidation", async () => {
    const { h, ctx, bot, workspace } = await setup();
    const marked = seedRun(h, bot.id, { at: "2026-10-01T01:00:00.000Z", status: "succeeded" });
    for (let i = 0; i < 10; i += 1)
      ctx.memory.entries.insert({
        workspaceId: workspace.id as WorkspaceId,
        scope: "bot",
        kind: "candidate",
        botId: bot.id,
        body: `Habit number ${i} from a run that was wrong.`,
        authority: "procedure",
        trust: "trusted",
        sourceKind: "bot_self",
        sourceRunId: marked,
        by: `bot:${bot.id}`,
      });
    await h.api("PUT", `/api/runs/${marked}/mark`, {});
    expect(ctx.memory.consolidation.requestEligible(new Date("2026-10-10T00:00:00Z"))).toEqual([]);
    expect(() => ctx.memory.consolidation.request(bot.id)).toThrow(/Nothing to consolidate/);
    await h.api("DELETE", `/api/runs/${marked}/mark`);
    expect(ctx.memory.consolidation.requestEligible(new Date("2026-10-10T00:00:00Z"))).toHaveLength(
      1,
    );
  });

  it("records the learned items of a run marked before it ends as skipped and writes none", async () => {
    h = await startHarness();
    const { thread, workspace } = await h.seed();
    const ctx = h.app.deskmates.ctx;
    const harness = h;
    const requests: StartRunRequest[] = [];
    h.provider.onRun(async (req, gw) => {
      requests.push(req);
      // The operator marks the run while it is still going.
      expect((await harness.api("PUT", `/api/runs/${req.runId}/mark`, {})).status).toBe(200);
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: {
          done: "done",
          filesChanged: [],
          sitesVisited: [],
          pendingApprovals: [],
          memorySuggestions: [],
          learned: [
            {
              body: "The refund page needs a manager code.",
              proposedScope: "workspace",
              authority: "fact",
              turn: 1,
              trust: "trusted",
              sourceKind: "bot_self",
            },
          ],
          reply: "done",
        },
        usage: [],
      });
    });
    await h.api("POST", `/api/threads/${thread.id}/messages`, { body: "go", authorId: "owner" });
    await waitFor(
      () =>
        requests.length === 1 &&
        ctx.runs.list({ threadId: thread.id }).every((r) => r.status === "succeeded"),
    );
    const runId = requests[0]?.runId as RunId;
    const skipped = ctx.db
      .prepare("SELECT payload_json FROM run_events WHERE run_id = ? AND kind = 'memory_skipped'")
      .all(runId) as { payload_json: string }[];
    expect(skipped.map((row) => JSON.parse(row.payload_json).reason)).toEqual([
      MARKED_WRONG_REASON,
    ]);
    expect(
      ctx.memory.entries
        .list({ workspaceId: workspace.id as WorkspaceId })
        .filter((e) => e.sourceRunId === runId),
    ).toEqual([]);
  });
});

describe("what a run changed (ADR-0042 decision 4)", () => {
  it("answers the run's approvals, checkpoints, artifacts and memory writes, and nothing else's", async () => {
    const { h, ctx, bot, workspace, thread } = await setup();
    const runId = seedRun(h, bot.id, { at: "2026-10-10T01:00:00.000Z", status: "succeeded" });
    const other = seedRun(h, bot.id, { at: "2026-10-10T01:01:00.000Z", status: "succeeded" });
    const approval = ctx.approvals.create({
      id: "apr_audit_1" as ApprovalId,
      runId,
      botId: bot.id,
      threadId: thread.id,
      action: { toolName: "browser_click", input: { element: "Pay" } },
      riskLevel: "L2",
    });
    ctx.approvals.decide(approval.id, "deny", "human:owner", "not today");
    const note = ctx.memory.entries.insert({
      workspaceId: workspace.id as WorkspaceId,
      scope: "workspace",
      kind: "note",
      body: "Invoices close on the 25th.",
      authority: "fact",
      trust: "trusted",
      sourceKind: "bot_self",
      sourceRunId: runId,
      by: `bot:${bot.id}`,
    });
    const task = ctx.tasks.create(workspace.id as WorkspaceId, {
      title: "Close the invoices",
      runIds: [runId],
      artifacts: [{ path: "/work/invoices.csv", label: "Invoices", runId }],
    });
    const checkpoint = ctx.tasks.recordCheckpoint(runId, {
      taskId: task.id,
      completed: [{ unit: "March", outcome: "closed" }],
    });
    const changes = await h.api<{
      approvals: { id: string; decision?: string }[];
      checkpoints: unknown[];
      artifacts: unknown[];
      memoryWritten: { entryId: string; trust: string }[];
      mark?: unknown;
    }>("GET", `/api/runs/${runId}/changes`);
    expect(changes.status).toBe(200);
    expect(changes.json.approvals.map((a) => [a.id, a.decision])).toEqual([[approval.id, "deny"]]);
    expect(changes.json.memoryWritten).toEqual([
      expect.objectContaining({ entryId: note.id, trust: "trusted", scope: "workspace" }),
    ]);
    expect(changes.json.checkpoints).toEqual([
      expect.objectContaining({ id: checkpoint.id, taskId: task.id, attempt: 1 }),
    ]);
    expect(changes.json.artifacts).toEqual([
      { taskId: task.id, ordinal: 0, path: "/work/invoices.csv", label: "Invoices" },
    ]);
    expect(changes.json.mark).toBeUndefined();
    const empty = await h.api<{ approvals: unknown[]; memoryWritten: unknown[] }>(
      "GET",
      `/api/runs/${other}/changes`,
    );
    expect(empty.json).toMatchObject({ approvals: [], memoryWritten: [] });
  });
});
