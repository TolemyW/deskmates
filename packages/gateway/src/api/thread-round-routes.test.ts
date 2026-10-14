// T1: ADR-0005 amendment 4 through the Gateway — the per-message round mode, the round list, the
// scheduler running a parallel consultation without a round lock, cancel and retry routes.
// In-process provider, fake sidecar scripts; no model, no Docker.

import type { StartRunRequest, ThreadRound } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { RunRecord } from "../ledger/runs.js";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

const summary = (reply: string) => ({
  done: "handled",
  reply,
  filesChanged: [],
  sitesVisited: [],
  pendingApprovals: [],
  memorySuggestions: [],
});

async function group() {
  const h = await startHarness();
  harnesses.push(h);
  const ctx = h.app.deskmates.ctx;
  const ws = ctx.workspaces.create({ name: "rounds", sandboxProvider: "docker" });
  const bots = ["ann", "ben", "cat", "dan"].map((name) =>
    ctx.bots.create({ name, role: name, workspaceId: ws.id }),
  );
  const thread = ctx.threads.create({ workspaceId: ws.id, botIds: bots.map((b) => b.id) });
  return { h, ctx, bots, thread };
}

describe("posting with a round mode", () => {
  it("sequential is accepted for @everyone, anything else is refused", async () => {
    const { h, thread } = await group();
    h.app.deskmates.scheduler.stop();
    const bad = await h.api("POST", `/api/threads/${thread.id}/messages`, {
      body: "@everyone hi",
      roundMode: "fast",
    });
    expect(bad.status).toBe(400);
    const posted = await h.api<{ runs: RunRecord[]; message: { id: string } }>(
      "POST",
      `/api/threads/${thread.id}/messages`,
      { body: "@everyone discuss", roundMode: "sequential" },
    );
    expect(posted.status).toBe(201);
    expect(posted.json.runs).toHaveLength(1);
    const listed = await h.api<{ rounds: ThreadRound[] }>(
      "GET",
      `/api/threads/${thread.id}/rounds`,
    );
    expect(listed.json.rounds).toHaveLength(1);
    expect(listed.json.rounds[0]).toMatchObject({ mode: "sequential", total: 4, completed: 0 });
  });
});

describe("parallel consultation through the scheduler", () => {
  it("a bot's mid-run @everyone starts every other member while the author still runs", async () => {
    const { h, ctx, bots, thread } = await group();
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.provider.onRun(async (req: StartRunRequest, gw) => {
      started.push(req.botName);
      if (req.botName === "ann" && started.filter((n) => n === "ann").length === 1) {
        await gw.post("messages", { tool: "thread_post", body: "@everyone need your numbers" });
        // The parent waits for its children to start: with a round lock this never resolves.
        await gate;
      }
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        usage: [],
        summary: summary(""),
      });
    });
    await h.api("POST", `/api/threads/${thread.id}/messages`, { body: "@ann coordinate" });
    await waitFor(
      () => ["ben", "cat", "dan"].every((name) => started.includes(name)),
      3000,
      "children started while the parent runs",
    );
    expect(
      ctx.runs.list({ threadId: thread.id }).find((r) => r.botId === bots[0]?.id)?.status,
    ).toBe("running");
    release();
    await waitFor(() =>
      ctx.runs.list({ threadId: thread.id }).every((r) => r.status !== "running"),
    );
    await h.app.deskmates.scheduler.drain();
    const rounds = (
      await h.api<{ rounds: ThreadRound[] }>("GET", `/api/threads/${thread.id}/rounds`)
    ).json.rounds;
    const child = rounds.find((r) => r.authorKind === "bot");
    expect(child?.members.map((m) => m.state)).toEqual(["silent", "silent", "silent"]);
    expect(child?.parentMessageId).toBe(rounds.find((r) => r.authorKind === "human")?.messageId);
  });
});

describe("cancel and retry routes", () => {
  it("cancel stops one round's runs and leaves another round's alone", async () => {
    const { h, ctx, thread } = await group();
    h.app.deskmates.scheduler.stop();
    const first = await h.api<{ message: { id: string } }>(
      "POST",
      `/api/threads/${thread.id}/messages`,
      { body: "@ann @ben first" },
    );
    const second = await h.api<{ message: { id: string } }>(
      "POST",
      `/api/threads/${thread.id}/messages`,
      { body: "@cat second" },
    );
    const cancelled = await h.api<{ cancelled: string[]; round: ThreadRound }>(
      "POST",
      `/api/threads/${thread.id}/rounds/${first.json.message.id}/cancel`,
      {},
    );
    expect(cancelled.status).toBe(200);
    expect(cancelled.json.cancelled).toHaveLength(2);
    expect(cancelled.json.round.cancelledAt).toBeDefined();
    const other = ctx.rounds.get(second.json.message.id as never);
    expect(other?.members.map((m) => m.state)).toEqual(["queued"]);
    const missing = await h.api("POST", `/api/threads/${thread.id}/rounds/msg_nope/cancel`, {});
    expect(missing.status).toBe(404);
  });

  it("retry creates one run for a failed member and is idempotent", async () => {
    const { h, ctx, bots, thread } = await group();
    h.app.deskmates.scheduler.stop();
    const posted = await h.api<{ message: { id: string }; runs: RunRecord[] }>(
      "POST",
      `/api/threads/${thread.id}/messages`,
      { body: "@everyone go" },
    );
    const cat = posted.json.runs.find((r) => r.botId === bots[2]?.id) as RunRecord;
    ctx.runs.transition(cat.id, "running");
    ctx.runs.transition(cat.id, "failed", { error: "boom" });
    const path = `/api/threads/${thread.id}/rounds/${posted.json.message.id}/members/${bots[2]?.id}/retry`;
    const first = await h.api<{ run: RunRecord; round: ThreadRound }>("POST", path, {});
    expect(first.status).toBe(201);
    expect(first.json.round.members[2]).toMatchObject({ state: "queued" });
    const again = await h.api<{ run: RunRecord }>("POST", path, {});
    expect(again.status).toBe(200);
    expect(again.json.run.id).toBe(first.json.run.id);
  });
});
