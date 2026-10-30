// T1: a Gateway start finds runs the ledger lists as live (ADR-0029 decisions 4 to 10). The first
// Gateway writes the ledger as a killed process would have left it; a second one on the same file
// database revokes their tokens, kills their old sidecars by run marker, and parks them for
// continuation instead of failing them. The fake provider plays the sidecars of the second one.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ApprovalId,
  type BotDefinition,
  RUN_ERROR_GATEWAY_RESTARTED,
  RUN_MARKER_ENV,
  type RunId,
  type RuntimeStatus,
  type StartRunRequest,
  type Thread,
  type ThreadId,
} from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INTERRUPTED_L2_NOTICE } from "../approvals/broker.js";
import type { GatewayContext } from "../context.js";
import type { RunRecord } from "../ledger/runs.js";
import { FakeProvider, type FakeSidecarClient } from "../test-support/fake-provider.js";
import { type Harness, nextTurn, startHarness, waitFor } from "../test-support/harness.js";

const MODEL = "test-model-default";

let dir: string;
let dbPath: string;
let harnesses: Harness[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "deskmates-restart-"));
  dbPath = join(dir, "gateway.db");
  harnesses = [];
});

afterEach(async () => {
  for (const h of harnesses.reverse()) await h.close().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

function summary(reply: string) {
  return {
    done: "done",
    filesChanged: [],
    sitesVisited: [],
    pendingApprovals: [],
    memorySuggestions: [],
    reply,
  };
}

async function finish(gw: FakeSidecarClient, req: StartRunRequest, reply = "ok"): Promise<void> {
  const res = await gw.post("ended", {
    type: "run_ended",
    runId: req.runId,
    outcome: "completed",
    sdkSessionId: req.sdkSessionId ?? "sess-fresh",
    usage: [],
    summary: summary(reply),
  });
  if (res.status !== 200) throw new Error(`ended returned ${res.status}: ${await res.text()}`);
}

interface First {
  ctx: GatewayContext;
  bot: BotDefinition;
  thread: Thread;
}

/** The Gateway that "dies": its scheduler never launches; the test writes what runs left. */
async function firstGateway(): Promise<First> {
  const h = await startHarness({ dbPath });
  h.app.deskmates.scheduler.stop();
  const { bot, thread } = await h.seed();
  harnesses.push(h);
  return { ctx: h.app.deskmates.ctx, bot, thread };
}

/** A run its sidecar was executing when the Gateway died. */
function liveRun(
  first: First,
  opts: {
    threadId?: ThreadId;
    session?: string;
    status?: "running" | "waiting_approval_live";
    config?: Record<string, unknown>;
  } = {},
): { run: RunRecord; token: string } {
  const { ctx, bot } = first;
  const created = opts.threadId
    ? ctx.runs.create({
        botId: bot.id,
        threadId: opts.threadId,
        lane: "interactive",
        triggerKind: "thread_message",
        triggerRef: ctx.messages.append({
          threadId: opts.threadId,
          authorKind: "human",
          authorId: "usr_test",
          body: "keep going",
          relayCount: 0,
        }).id,
        config: { ...ctx.runConfig(), deliveredFromSeq: 0, ...opts.config },
      })
    : ctx.runs.create({
        botId: bot.id,
        lane: "background",
        triggerKind: "webhook",
        triggerRef: `hook-${Math.random()}`,
        triggerPayload: { body: "do the webhook thing" },
        config: { ...ctx.runConfig(), ...opts.config },
      });
  ctx.runs.transition(created.id, "running");
  if (opts.status === "waiting_approval_live")
    ctx.runs.transition(created.id, "waiting_approval_live");
  if (opts.session) ctx.runs.setSession(created.id, opts.session, 1);
  const token = ctx.tokens.issue(created.id).token;
  return { run: ctx.runs.mustGet(created.id), token };
}

function toolCall(ctx: GatewayContext, runId: RunId, id: string, name: string, level: string) {
  ctx.events.append({
    runId,
    attempt: 1,
    kind: "tool_call",
    payload: { toolUseId: id, toolName: name, riskLevel: level, input: {} },
  });
}

function toolResult(ctx: GatewayContext, runId: RunId, id: string) {
  ctx.events.append({
    runId,
    attempt: 1,
    kind: "tool_result",
    payload: { toolUseId: id, isError: false },
  });
}

/** The Gateway that starts on the same database, with the old workspace's sandbox to attach. */
async function secondGateway(first: First, provider = new FakeProvider()): Promise<Harness> {
  provider.existing.set(first.bot.workspaceId, {
    workspaceId: first.bot.workspaceId,
    providerRef: "fake-old-container",
    sidecarAddress: "fake://sidecar",
  });
  const h = await startHarness({ dbPath }, undefined, { provider });
  harnesses.push(h);
  return h;
}

describe("reconcile parks live runs for continuation (decision 4)", () => {
  it("kills every old sidecar first, resumes a run with a session, requeues one without, leaves parked runs", async () => {
    const first = await firstGateway();
    const { ctx } = first;
    const withSession = liveRun(first, { threadId: first.thread.id, session: "sess-A" });
    const noSession = liveRun(first);
    const parked = ctx.runs.create({
      botId: first.bot.id,
      lane: "background",
      triggerKind: "webhook",
      triggerRef: "parked",
      triggerPayload: { body: "parked" },
      config: ctx.runConfig(),
    });
    ctx.runs.transition(parked.id, "running");
    ctx.approvals.create({
      id: "apr-parked" as ApprovalId,
      runId: parked.id,
      botId: first.bot.id,
      action: { toolName: "Bash", input: {}, argumentSummary: "rm -rf /x" },
      riskLevel: "L2",
    });
    ctx.runs.transition(parked.id, "waiting_approval", {
      resumePayload: { sdkSessionId: "sess-P", approvalId: "apr-parked" },
    });

    const provider = new FakeProvider();
    const requests: StartRunRequest[] = [];
    provider.onRun(async (req, gw) => {
      requests.push(req);
      await finish(gw, req);
    });
    const h = await secondGateway(first, provider);
    const next = h.app.deskmates.ctx;
    await waitFor(() => requests.length === 2, 3000, "the resume and the requeue");
    await h.app.deskmates.scheduler.drain();

    // Both live runs were killed by marker, before any sidecar of the new Gateway started.
    expect(provider.killedRuns.map((k) => k.runId).sort()).toEqual(
      [withSession.run.id, noSession.run.id].sort(),
    );
    expect(provider.killedRuns.every((k) => k.execCallsBefore === 0)).toBe(true);
    expect(provider.killedRuns.every((k) => k.workspaceId === first.bot.workspaceId)).toBe(true);
    // Every sidecar the new Gateway starts carries its run marker, for the next restart to find.
    expect(provider.execCalls.every((c) => c.req.env?.[RUN_MARKER_ENV] === c.request.runId)).toBe(
      true,
    );

    const resumed = requests.find((r) => r.runId === withSession.run.id) as StartRunRequest;
    expect(resumed.attempt).toBe(2);
    expect(resumed.sdkSessionId).toBe("sess-A");
    expect(resumed.trigger).toEqual({ kind: "platform_resume", reason: "restart" });
    const requeued = requests.find((r) => r.runId === noSession.run.id) as StartRunRequest;
    expect(requeued.attempt).toBe(2);
    expect(requeued.sdkSessionId).toBeUndefined();
    expect(requeued.trigger.kind).toBe("webhook");

    expect(next.runs.mustGet(withSession.run.id).status).toBe("succeeded");
    expect(next.runs.mustGet(noSession.run.id).status).toBe("succeeded");
    expect(next.runs.mustGet(parked.id).status).toBe("waiting_approval");
    expect(next.runs.mustGet(withSession.run.id).config.platformResumes).toBe(1);
    // Parking and an automatic continuation post nothing in the thread (decision 7).
    expect(
      next.messages.list(first.thread.id, 0).filter((m) => m.authorKind === "system"),
    ).toHaveLength(0);
    const log = next.events
      .list(withSession.run.id)
      .filter((e) => e.kind === "log" && e.payload.source === "platform")
      .map((e) => e.payload.op);
    expect(log).toEqual(["killed", "restart_found_live", "parked", "resumed"]);
  });

  it("revokes the old tokens: the model proxy and every internal route refuse them (decision 9)", async () => {
    const first = await firstGateway();
    const { run, token } = liveRun(first, { session: "sess-T" });
    const provider = new FakeProvider();
    let resumedToken = "";
    const release: { go?: () => void } = {};
    provider.onRun(async (req, gw) => {
      resumedToken = req.modelAuthToken;
      await new Promise<void>((resolve) => {
        release.go = resolve;
      });
      await finish(gw, req);
    });
    const h = await secondGateway(first, provider);
    await waitFor(() => resumedToken !== "", 3000, "the resumed attempt");
    const call = (path: string, bearer: string) =>
      fetch(`${h.baseUrl}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify([]),
      });
    expect((await call(`/internal/runs/${run.id}/events`, token)).status).toBe(401);
    expect((await call(`/internal/runs/${run.id}/ended`, token)).status).toBe(401);
    expect((await call("/v1/messages", token)).status).toBe(401);
    expect(resumedToken).not.toBe(token);
    expect((await call(`/internal/runs/${run.id}/events`, resumedToken)).status).toBe(200);
    release.go?.();
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded",
      3000,
      "the resumed run's end",
    );
  });

  it("leaves sidecar crashes, the deadline and the budget cap to end failed (ADR-0016 decision 2)", async () => {
    const h = await startHarness();
    harnesses.push(h);
    const { thread } = await h.seed();
    const { ctx, scheduler } = h.app.deskmates;
    h.provider.onRun(async () => ({ exitCode: 1, stderr: "segfault" }));
    const m = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${thread.id}/messages`, {
      body: "crash",
    });
    const crashed = m.json.runs[0] as RunRecord;
    await waitFor(() => ctx.runs.mustGet(crashed.id).status === "failed", 3000, "the crash");
    await scheduler.drain();
    expect(ctx.runs.mustGet(crashed.id).error).toMatch(/sidecar exited without run_ended/);
    expect(ctx.runs.mustGet(crashed.id).status).not.toBe("waiting_platform");
  });
});

describe("an interrupted tool call is handled by its tier (decision 5)", () => {
  it("names the interrupted call per tier and never re-executes it", async () => {
    const first = await firstGateway();
    const { ctx } = first;
    const l0 = liveRun(first, { session: "sess-L0" });
    toolCall(ctx, l0.run.id, "tu_done", "Read", "L0");
    toolResult(ctx, l0.run.id, "tu_done");
    toolCall(ctx, l0.run.id, "tu_read", "Read", "L0");
    const l1 = liveRun(first, { session: "sess-L1" });
    toolCall(ctx, l1.run.id, "tu_write", "Write", "L1");
    const provider = new FakeProvider();
    const requests: StartRunRequest[] = [];
    provider.onRun(async (req, gw) => {
      requests.push(req);
      await finish(gw, req);
    });
    const h = await secondGateway(first, provider);
    await waitFor(() => requests.length === 2, 3000, "both resumes");
    await h.app.deskmates.scheduler.drain();
    const byRun = new Map(requests.map((r) => [r.runId, r]));
    expect(byRun.get(l0.run.id)?.trigger).toEqual({
      kind: "platform_resume",
      reason: "restart",
      interruptedCall: { toolUseId: "tu_read", toolName: "Read", riskLevel: "L0" },
    });
    expect(byRun.get(l1.run.id)?.trigger).toEqual({
      kind: "platform_resume",
      reason: "restart",
      interruptedCall: { toolUseId: "tu_write", toolName: "Write", riskLevel: "L1" },
    });
    // Every exec is a sidecar start with the trigger above, never a replay of the call itself.
    expect(provider.execCalls.every((c) => c.request.trigger.kind === "platform_resume")).toBe(
      true,
    );
  });

  it("after an interrupted L2 call, an Always rule does not answer the same action and a human is asked", async () => {
    const first = await firstGateway();
    const { ctx, bot } = first;
    const action = {
      toolName: "mcp__browser__browser_click",
      input: {},
      targetOrigin: "https://shop.example.test",
      argumentSummary: "click pay",
      argumentPattern: "*pay*",
    };
    ctx.rules.create({
      botId: bot.id,
      matcher: {
        toolName: action.toolName,
        targetOrigin: action.targetOrigin,
        argumentPattern: action.argumentPattern,
      },
      decision: "allow_always",
      createdBy: "human:usr_test",
    });
    const { run } = liveRun(first, { threadId: first.thread.id, session: "sess-L2" });
    toolCall(ctx, run.id, "tu_pay", action.toolName, "L2");
    // The rule allowed the call in the first attempt; then the Gateway died mid-call.
    ctx.approvals.create({
      id: "apr-first" as ApprovalId,
      runId: run.id,
      botId: bot.id,
      threadId: first.thread.id,
      action,
      riskLevel: "L2",
      toolUseId: "tu_pay",
      decision: "allow_always",
      decidedBy: "rule:x",
    });
    const provider = new FakeProvider();
    let asked: number | undefined;
    let other: unknown;
    provider.onRun(async (req, gw) => {
      expect(req.trigger).toMatchObject({
        kind: "platform_resume",
        interruptedCall: {
          toolUseId: "tu_pay",
          riskLevel: "L2",
          targetOrigin: action.targetOrigin,
          argumentPattern: action.argumentPattern,
        },
      });
      const again = await gw.post("approvals", {
        type: "approval_request",
        approvalId: "apr-again",
        action,
        riskLevel: "L2",
        toolUseId: "tu_pay_2",
        afterInterruption: true,
      });
      asked = again.status;
      // An L2 call with other dimensions is still answered by the rule set as usual.
      const different = await gw.post("approvals", {
        type: "approval_request",
        approvalId: "apr-other",
        action: { ...action, argumentSummary: "click pay later", argumentPattern: "*pay later*" },
        riskLevel: "L2",
        toolUseId: "tu_other",
      });
      other = await different.json();
      await finish(gw, req);
    });
    const h = await secondGateway(first, provider);
    await waitFor(() => asked !== undefined, 3000, "the resumed attempt's request");
    await h.app.deskmates.scheduler.drain();
    const next = h.app.deskmates.ctx;
    // Nobody online: the request goes to the thread and the hook is told to defer, never allowed.
    expect(asked).toBe(200);
    const again = next.approvals.get("apr-again" as ApprovalId);
    expect(again?.decision).toBeUndefined();
    expect(again?.decidedBy).toBeUndefined();
    const card = next.messages
      .list(first.thread.id, 0)
      .find((m) => m.authorKind === "system" && m.body.includes(INTERRUPTED_L2_NOTICE));
    expect(card).toBeDefined();
    expect(other).toMatchObject({ decision: "allow" });
    expect(next.approvals.get("apr-other" as ApprovalId)?.decidedBy).toMatch(/rule/);
  });

  it("a live approval wait whose approval is still pending was never executed: it waits on it", async () => {
    const first = await firstGateway();
    const { ctx, bot } = first;
    const { run } = liveRun(first, { session: "sess-W", status: "waiting_approval_live" });
    toolCall(ctx, run.id, "tu_wait", "Bash", "L2");
    ctx.approvals.create({
      id: "apr-wait" as ApprovalId,
      runId: run.id,
      botId: bot.id,
      action: { toolName: "Bash", input: {}, argumentSummary: "deploy" },
      riskLevel: "L2",
      toolUseId: "tu_wait",
    });
    const h = await secondGateway(first);
    const next = h.app.deskmates.ctx;
    await waitFor(
      () => next.runs.mustGet(run.id).status === "waiting_approval",
      3000,
      "the run to wait on its approval",
    );
    expect(next.runs.mustGet(run.id).config.platformL2Recheck).toBeNull();
    expect(h.provider.execCalls).toHaveLength(0);
  });
});

describe("recovery is capped and a crash loop stops it (decision 6)", () => {
  it("a fourth interruption ends the run failed with gateway_restarted and one inert notice", async () => {
    const first = await firstGateway();
    const { run } = liveRun(first, {
      threadId: first.thread.id,
      session: "sess-4",
      config: { platformResumes: 3 },
    });
    const h = await secondGateway(first);
    const next = h.app.deskmates.ctx;
    await nextTurn();
    const after = next.runs.mustGet(run.id);
    expect(after.status).toBe("failed");
    expect(after.error).toBe(RUN_ERROR_GATEWAY_RESTARTED);
    const notices = next.messages
      .list(first.thread.id, 0)
      .filter((m) => m.authorKind === "system" && m.body.includes("platform restart"));
    expect(notices).toHaveLength(1);
    expect(notices[0]?.body).toContain(first.bot.name);
    // Routing-inert: nobody was woken by it.
    expect(next.runs.list({ threadId: first.thread.id }).filter((r) => r.id !== run.id)).toEqual(
      [],
    );
  });

  it("a run failed at the limit closes its approvals and a lost review goes to humans (#61 H2/M6)", async () => {
    const first = await firstGateway();
    const { ctx, bot, thread } = first;
    // A run holding an open approval hits the limit.
    const { run: holder } = liveRun(first, {
      threadId: thread.id,
      session: "sess-holder",
      config: { platformResumes: 3 },
    });
    ctx.approvals.create({
      id: "apr-held" as ApprovalId,
      runId: holder.id,
      botId: bot.id,
      threadId: thread.id,
      action: { toolName: "Bash", input: {}, argumentSummary: "deploy" },
      riskLevel: "L2",
      toolUseId: "tu_held",
    });
    // A parked run whose approval an automatic review job was answering when the Gateway died.
    const requester = ctx.runs.create({
      botId: bot.id,
      threadId: thread.id,
      lane: "interactive",
      triggerKind: "thread_message",
      triggerRef: ctx.messages.append({
        threadId: thread.id,
        authorKind: "human",
        authorId: "usr_test",
        body: "push it",
        relayCount: 0,
      }).id,
      config: { ...ctx.runConfig(), deliveredFromSeq: 0 },
    });
    ctx.runs.transition(requester.id, "running");
    ctx.runs.transition(requester.id, "waiting_approval");
    ctx.approvals.create({
      id: "apr-reviewed" as ApprovalId,
      runId: requester.id,
      botId: bot.id,
      threadId: thread.id,
      action: { toolName: "Bash", input: {}, argumentSummary: "git push" },
      riskLevel: "L2",
      toolUseId: "tu_reviewed",
    });
    const { run: review } = liveRun(first, {
      session: "sess-review",
      config: {
        runType: "approval_review",
        approvalId: "apr-reviewed",
        reviewedRunId: requester.id,
        platformResumes: 3,
      },
    });
    const h = await secondGateway(first);
    const next = h.app.deskmates.ctx;
    await nextTurn();
    for (const id of [holder.id, review.id]) {
      expect(next.runs.mustGet(id).status).toBe("failed");
      expect(next.runs.mustGet(id).error).toBe(RUN_ERROR_GATEWAY_RESTARTED);
    }
    expect(next.approvals.mustGet("apr-held" as ApprovalId)).toMatchObject({
      decision: "deny",
      decidedBy: "system:failed",
    });
    // The review settled nothing: its approval stays open and is posted for humans.
    const reviewed = next.approvals.mustGet("apr-reviewed" as ApprovalId);
    expect(reviewed.decision).toBeUndefined();
    expect(reviewed.messageId).toBeDefined();
    const escalated = next.events
      .list(requester.id)
      .find((e) => e.kind === "approval" && e.payload.phase === "review_escalated");
    expect(escalated?.payload).toMatchObject({ reason: "review_failed", reviewRunId: review.id });
  });

  it("more than three starts in ten minutes park live runs and resume none until an operator does", async () => {
    const first = await firstGateway();
    // Starts outside the window do not count.
    first.ctx.db
      .prepare("INSERT INTO gateway_starts (started_at, last_seen_at) VALUES (?, ?)")
      .run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    for (let i = 0; i < 2; i++) {
      const h = await startHarness({ dbPath });
      harnesses.push(h);
      expect(h.app.deskmates.scheduler.breakerTripped).toBe(false);
    }
    const { run } = liveRun(first, { session: "sess-loop" });
    const provider = new FakeProvider();
    provider.onRun(async (req, gw) => finish(gw, req));
    const h = await secondGateway(first, provider);
    const next = h.app.deskmates.ctx;
    expect(h.app.deskmates.scheduler.breakerTripped).toBe(true);
    h.app.deskmates.scheduler.tick();
    await nextTurn();
    expect(next.runs.mustGet(run.id).status).toBe("waiting_platform");
    expect(provider.execCalls).toHaveLength(0);
    const status = (await h.api<RuntimeStatus>("GET", "/api/runtime")).json;
    expect(status.restartBreaker).toMatchObject({ tripped: true, heldRunIds: [run.id] });
    expect(status.restartBreaker.startsInWindow).toBe(4);

    const resumed = await h.api<{ resumedRunIds: RunId[] }>(
      "POST",
      "/api/runtime/platform-resume",
      {},
    );
    expect(resumed.json.resumedRunIds).toEqual([run.id]);
    await waitFor(
      () => next.runs.mustGet(run.id).status === "succeeded",
      3000,
      "the operator resume",
    );
  });
});

describe("abnormally ended attempts keep their usage (decision 8)", () => {
  it("fills the killed attempt from its proxied requests and sources the next attempt the same way", async () => {
    const first = await firstGateway();
    const { ctx } = first;
    const { run } = liveRun(first, { session: "sess-U" });
    for (const [input, output] of [
      [100, 10],
      [200, 20],
    ] as const) {
      const id = ctx.modelRequests.insert({
        runId: run.id,
        attempt: 1,
        ts: new Date().toISOString(),
        requestKind: "messages",
        model: MODEL,
        stream: true,
      });
      ctx.modelRequests.setUsage(id, {
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        servedModel: MODEL,
      });
    }
    const provider = new FakeProvider();
    provider.onRun(async (req, gw) => {
      const next = h.app.deskmates.ctx;
      const id = next.modelRequests.insert({
        runId: req.runId,
        attempt: req.attempt,
        ts: new Date().toISOString(),
        requestKind: "messages",
        model: MODEL,
        stream: true,
      });
      next.modelRequests.setUsage(id, {
        inputTokens: 50,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        servedModel: MODEL,
      });
      // The SDK's cumulative total includes the killed attempt, which it never reported.
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        sdkSessionId: "sess-U",
        usage: [
          {
            model: MODEL,
            inputTokens: 350,
            outputTokens: 35,
            cacheReadTokens: 0,
            cacheCreateTokens: 0,
          },
        ],
        summary: summary("done"),
      });
    });
    const h = await secondGateway(first, provider);
    const next = h.app.deskmates.ctx;
    await waitFor(() => next.runs.mustGet(run.id).status === "succeeded", 3000, "the resumed end");
    await h.app.deskmates.scheduler.drain();
    const rows = next.usage.listByAttempt(run.id);
    expect(rows.map((r) => [r.attempt, r.source, r.inputTokens, r.outputTokens])).toEqual([
      [1, "proxy", 300, 30],
      [2, "proxy", 50, 5],
    ]);
    // Never double counted: the run is what its requests spent.
    expect(next.usage.list(run.id)[0]?.inputTokens).toBe(350);
  });
});

describe("a resume that cannot read its session continues fresh (decision 10)", () => {
  it("records the SDK build the run started on, and logs a resume on another build", async () => {
    const h = await startHarness();
    harnesses.push(h);
    const { thread } = await h.seed();
    const { ctx } = h.app.deskmates;
    const init = (req: StartRunRequest, version: string) => ({
      type: "event",
      runId: req.runId,
      attempt: req.attempt,
      seq: 1,
      kind: "log",
      payload: { source: "sdk", cliVersion: version, usageSessionFingerprint: "f".repeat(64) },
      ts: new Date().toISOString(),
    });
    h.provider.onRun(async (req, gw) => {
      await gw.post("events", [init(req, req.attempt === 1 ? "2.1.0" : "2.2.0")]);
      if (req.attempt === 1) {
        await gw.post("ended", {
          type: "run_ended",
          runId: req.runId,
          outcome: "deferred",
          sdkSessionId: "sess-v",
          usage: [],
          platformInterruption: { interruption: "platform", reason: "drain" },
        });
        return;
      }
      await finish(gw, req);
    });
    h.app.deskmates.scheduler.startDrain();
    h.app.deskmates.scheduler.endDrain();
    const m = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${thread.id}/messages`, {
      body: "versions",
    });
    const run = m.json.runs[0] as RunRecord;
    await waitFor(() => ctx.runs.mustGet(run.id).status === "succeeded", 3000, "the resume");
    expect(ctx.runs.mustGet(run.id).config.sdkVersion).toBe("2.1.0");
    const changed = ctx.events
      .list(run.id)
      .find((e) => e.kind === "log" && e.payload.op === "sdk_version_changed");
    expect(changed?.payload).toMatchObject({ from: "2.1.0", to: "2.2.0" });
  });

  it("records the SDK the run started on and hands a fresh session a wrapped Gateway handoff", async () => {
    const first = await firstGateway();
    const { ctx } = first;
    const { run } = liveRun(first, { threadId: first.thread.id, session: "sess-gone" });
    ctx.runs.setDeliveredSeq(run.id, 1);
    ctx.runs.setConfig(run.id, { sdkVersion: "2.1.0" });
    toolCall(ctx, run.id, "tu_x", "Write", "L1");
    toolResult(ctx, run.id, "tu_x");
    const provider = new FakeProvider();
    const requests: StartRunRequest[] = [];
    provider.onRun(async (req, gw) => {
      requests.push(req);
      if (req.attempt === 2) {
        // The new image's SDK cannot read the old session.
        await gw.post("ended", {
          type: "run_ended",
          runId: req.runId,
          outcome: "failed",
          usage: [],
          error: "No conversation found with session ID: sess-gone",
          resumeFailed: true,
        });
        return;
      }
      await finish(gw, req);
    });
    const h = await secondGateway(first, provider);
    const next = h.app.deskmates.ctx;
    await waitFor(() => next.runs.mustGet(run.id).status === "succeeded", 3000, "the fresh run");
    await h.app.deskmates.scheduler.drain();
    expect(requests.map((r) => [r.attempt, r.sdkSessionId])).toEqual([
      [2, "sess-gone"],
      [3, undefined],
    ]);
    const fresh = requests[1]?.trigger;
    expect(fresh?.kind).toBe("platform_resume");
    const handoff = fresh?.kind === "platform_resume" ? fresh.freshSession?.handoff : undefined;
    expect(handoff).toContain("could not be resumed");
    expect(handoff).toMatch(
      /#1 human: <untrusted source="human:usr_test">\s*keep going\s*<\/untrusted>/,
    );
    expect(handoff).toContain("attempt 1: Write (L1)");
    expect(next.runs.mustGet(run.id).config.sdkVersion).toBe("2.1.0");
    expect(next.runs.mustGet(run.id).config.platformResumes).toBe(2);
  });
});
