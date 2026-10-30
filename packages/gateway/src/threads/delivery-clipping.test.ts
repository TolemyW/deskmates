// Characterization, not a fix: expose the current payload/cursor disagreement through the
// real stores, router, run start/end and delegation attribution, without a model.
import { RUN_ERROR_NO_REPLY, type RunEnded } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { buildContext } from "../context.js";
import { type GatewayDb, openDatabase } from "../db/open.js";
import type { RunRecord } from "../ledger/runs.js";
import { RunLifecycle } from "../scheduler/run-lifecycle.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { testConfig } from "../test-support/harness.js";
import { delegationsOf } from "./delegation-outcomes.js";

function requireRun(run: RunRecord | undefined): RunRecord {
  if (!run) throw new Error("expected a queued run");
  return run;
}

const databases: GatewayDb[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function setup(maxTokens = 24) {
  const db = openDatabase(":memory:");
  databases.push(db);
  const ctx = buildContext(
    testConfig({ threadPayloadMaxTokens: maxTokens, groupRouting: "owner-v1" }),
    db,
    new FakeProvider(),
    () => "http://gateway.test",
  );
  const workspace = ctx.workspaces.create({ name: "clipping", sandboxProvider: "docker" });
  const chief = ctx.bots.create({ name: "chief", role: "coordinator", workspaceId: workspace.id });
  const worker = ctx.bots.create({ name: "worker", role: "engineer", workspaceId: workspace.id });
  const thread = ctx.threads.create({ workspaceId: workspace.id, botIds: [chief.id, worker.id] });
  return { ctx, chief, worker, thread, lifecycle: new RunLifecycle(ctx) };
}

function completed(runId: RunEnded["runId"]): RunEnded {
  return {
    type: "run_ended",
    runId,
    outcome: "completed",
    usage: [],
    summary: {
      done: "No answer",
      filesChanged: [],
      sitesVisited: [],
      pendingApprovals: [],
      memorySuggestions: [],
      reply: "",
    },
  };
}

describe("delivery clipping characterization", () => {
  it.each([24, 2_000])(
    "a coalesced must-reply request at budget %i is still required and acknowledged",
    (maxTokens) => {
      const s = setup(maxTokens);
      const first = s.ctx.router.postHuman({
        threadId: s.thread.id,
        body: "@worker answer the earlier question",
        mustReply: true,
      });
      const later = s.ctx.router.postHuman({
        threadId: s.thread.id,
        body: `@worker later context ${"界".repeat(300)}`,
      });
      expect(later.runs).toEqual([]); // coalesced onto the already queued worker run
      const run = requireRun(first.runs[0]);
      const request = s.lifecycle.start(run).request;
      expect(request.trigger.kind).toBe("thread_message");
      if (request.trigger.kind !== "thread_message") throw new Error("expected thread delivery");
      const seqs = request.trigger.messages.map((m) => m.seq);
      expect(seqs.includes(first.message.seq)).toBe(maxTokens === 2_000);
      expect(seqs).toContain(later.message.seq);
      if (maxTokens === 24)
        expect(request.trigger.messages[0]?.body).toBe("1 earlier messages omitted");
      expect(s.ctx.runs.mustGet(run.id).config.mustReply).toBe(true);
      expect(s.ctx.runs.mustGet(run.id).deliveredSeq).toBe(later.message.seq);

      s.lifecycle.ended(run.id, completed(run.id));
      expect(s.ctx.runs.mustGet(run.id)).toMatchObject({
        status: "failed",
        error: RUN_ERROR_NO_REPLY,
      });
      expect(s.ctx.threads.member(s.thread.id, s.worker.id)?.lastSeenSeq).toBe(later.message.seq);
      // Even when omitted, the original request survives only in history; no next-wake replay.
      const next = s.ctx.router.postHuman({ threadId: s.thread.id, body: "@worker new question" });
      const nextRequest = s.lifecycle.start(requireRun(next.runs[0])).request;
      if (nextRequest.trigger.kind !== "thread_message")
        throw new Error("expected thread delivery");
      expect(nextRequest.trigger.messages.some((m) => m.seq === first.message.seq)).toBe(false);
      expect(s.ctx.messages.get(first.message.id)?.body).toBe(first.message.body);
    },
  );

  it("attributes an omitted delegation and announces its outcome to the delegator", () => {
    const s = setup();
    const asked = s.ctx.router.postHuman({ threadId: s.thread.id, body: "@chief coordinate" });
    const chiefRun = s.ctx.runs.transition(requireRun(asked.runs[0]).id, "running", {
      deliveredSeq: asked.message.seq,
    });
    const delegated = s.ctx.router.postFromRun(chiefRun, "@worker inspect the critical failure");
    const workerRun = requireRun(s.ctx.runs.findQueued(s.worker.id, s.thread.id));
    s.ctx.router.postFromRun(chiefRun, `Later unrelated context ${"x".repeat(400)}`);
    const request = s.lifecycle.start(workerRun).request;
    if (request.trigger.kind !== "thread_message") throw new Error("expected thread delivery");
    expect(request.trigger.messages.some((m) => m.seq === delegated.seq)).toBe(false);
    expect(
      delegationsOf(s.ctx, s.ctx.runs.mustGet(workerRun.id)).map((d) => d.source.id),
    ).toContain(delegated.id);
    s.lifecycle.ended(workerRun.id, completed(workerRun.id));
    expect(
      s.ctx.events
        .list(workerRun.id)
        .some((e) => e.kind === "log" && e.payload.source === "delegation_outcome"),
    ).toBe(true);
    expect(s.ctx.threads.member(s.thread.id, s.worker.id)?.lastSeenSeq).toBeGreaterThanOrEqual(
      delegated.seq,
    );
  });
});
