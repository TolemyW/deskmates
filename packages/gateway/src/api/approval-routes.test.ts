// T1: the approval and rule routes (ADR-0002 amendment 2, rows A2 and A3). Decision order,
// membership as the whole test for `approval_decide`, wake on the request, and rule CRUD.

import type {
  Approval,
  ApprovalRule,
  BotDefinition,
  RunSummary,
  StartRunRequest,
  Thread,
  ThreadMessage,
  Workspace,
} from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunRecord } from "../ledger/runs.js";
import { type Harness, openSse, startHarness, waitFor } from "../test-support/harness.js";

function summary(reply: string): RunSummary {
  return {
    done: "done",
    filesChanged: [],
    sitesVisited: [],
    pendingApprovals: [],
    memorySuggestions: [],
    reply,
  };
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function clickAction(summaryText: string): Record<string, unknown> {
  return {
    toolName: "mcp__browser__browser_click",
    input: { element: summaryText, ref: "e42" },
    targetOrigin: "https://shop.example.test",
    argumentSummary: summaryText,
    argumentPattern: "*submit*",
  };
}

async function wake(h: Harness, threadId: string, body: string): Promise<RunRecord> {
  const m = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${threadId}/messages`, {
    body,
  });
  const run = m.json.runs[0];
  if (!run) throw new Error("no run created");
  return run;
}

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

describe("rules answer before the thread is asked (A3)", () => {
  it("Always stores a rule from the action, and a later matching call is allowed with no message", async () => {
    const { bot, thread } = await h.seed();
    const sse = await openSse(h.baseUrl);
    const gate = deferred();
    const answers: { status: number; body: unknown }[] = [];

    h.provider.onRun(async (req, gw) => {
      const first = await gw.post("approvals", {
        type: "approval_request",
        runId: req.runId,
        approvalId: "apr-a",
        action: clickAction("click submit order"),
        riskLevel: "L2",
      });
      answers.push({ status: first.status, body: null });
      await gate.promise;
      // Same tool and origin, different wording: the stored `*submit*` pattern still matches.
      const second = await gw.post("approvals", {
        type: "approval_request",
        runId: req.runId,
        approvalId: "apr-b",
        action: clickAction("press the submit button now"),
        riskLevel: "L2",
      });
      answers.push({ status: second.status, body: await second.json() });
      // A call with no known origin must not match a rule that names one.
      const third = await gw.post("approvals", {
        type: "approval_request",
        runId: req.runId,
        approvalId: "apr-c",
        action: { toolName: "mcp__browser__browser_click", input: {}, argumentSummary: "submit" },
        riskLevel: "L2",
      });
      answers.push({ status: third.status, body: null });
      // apr-c is still pending, so the run parks the way the hook's timeout would.
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "deferred",
        sdkSessionId: "sess-rules",
        usage: [],
        pendingApprovalId: "apr-c",
      });
    });

    const run = await wake(h, thread.id, "submit the order");
    await waitFor(() => answers.length === 1, 2000, "first request");
    const decided = await h.api<{ approval: Approval; rule: ApprovalRule }>(
      "POST",
      "/api/approvals/apr-a/decide",
      { decision: "allow_always", authorId: "ops" },
    );
    expect(decided.status).toBe(200);
    expect(decided.json.rule.matcher).toEqual({
      toolName: "mcp__browser__browser_click",
      targetOrigin: "https://shop.example.test",
      argumentPattern: "*submit*",
    });
    expect(decided.json.rule.createdBy).toBe("human:ops");
    expect(decided.json.rule.createdFromApprovalId).toBe("apr-a");

    gate.resolve();
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "waiting_approval",
      2000,
      "run parked on apr-c",
    );
    sse.close();

    // The second request was answered by the rule: 200 allow, no wait, no new message.
    expect(answers[1]).toEqual({
      status: 200,
      body: { type: "approval_response", approvalId: "apr-b", decision: "allow" },
    });
    const ruleId = decided.json.rule.id;
    expect(h.app.deskmates.ctx.approvals.mustGet("apr-b" as Approval["id"]).decidedBy).toBe(
      `rule:${ruleId}`,
    );
    // The third had no origin and so had to be asked; it is still pending.
    expect(answers[2]?.status).toBe(202);
    const systemMessages = h.app.deskmates.ctx.messages
      .list(thread.id)
      .filter((m) => m.authorKind === "system");
    // Request card for apr-a, the decision echo, and the request card for apr-c. Nothing for apr-b.
    expect(systemMessages).toHaveLength(3);
    expect(systemMessages.filter((m) => m.body.includes("Approval needed"))).toHaveLength(2);

    const phases = h.app.deskmates.ctx.events
      .list(run.id)
      .filter((e) => e.kind === "approval")
      .map((e) => [e.payload.phase, e.payload.approvalId]);
    expect(phases).toEqual([
      ["posted", "apr-a"],
      ["decided", "apr-a"],
      ["rule_matched", "apr-b"],
      ["posted", "apr-c"],
    ]);

    // Listing and deleting from the operator API; the delete is an event on the origin run.
    const listed = await h.api<{ rules: ApprovalRule[] }>(
      "GET",
      `/api/bots/${bot.id}/approval-rules`,
    );
    expect(listed.json.rules.map((r) => r.id)).toEqual([ruleId]);
    const removed = await h.api<{ deleted: boolean }>("DELETE", `/api/approval-rules/${ruleId}`);
    expect(removed.json).toEqual({ deleted: true });
    const afterDelete = h.app.deskmates.ctx.events
      .list(run.id)
      .filter((e) => e.payload.phase === "rule_deleted");
    expect(afterDelete).toHaveLength(1);
    expect(afterDelete[0]?.payload.ruleId).toBe(ruleId);
  });

  it("a deny rule typed by an operator answers deny, and another bot's rules do not apply", async () => {
    const { bot, thread, workspace } = await h.seed();
    const other = await h.api<{ bot: BotDefinition }>("POST", "/api/bots", {
      name: "bob",
      role: "tester",
      workspaceId: workspace.id,
    });
    const created = await h.api<{ rule: ApprovalRule }>(
      "POST",
      `/api/bots/${other.json.bot.id}/approval-rules`,
      {
        matcher: { toolName: "mcp__browser__browser_click" },
        decision: "deny",
      },
    );
    expect(created.status).toBe(201);

    let answer: unknown;
    h.provider.onRun(async (req, gw) => {
      const res = await gw.post("approvals", {
        type: "approval_request",
        runId: req.runId,
        approvalId: "apr-other",
        action: clickAction("click submit order"),
        riskLevel: "L2",
      });
      answer = { status: res.status };
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary("ok"),
        usage: [],
      });
    });
    const run = await wake(h, thread.id, "submit it");
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded",
      2000,
      "run",
    );
    // Rules are per bot: bob's deny rule never touches alice's request.
    expect(answer).toEqual({ status: 200 });
    expect(
      h.app.deskmates.ctx.approvals.mustGet("apr-other" as Approval["id"]).decision,
    ).toBeUndefined();

    // The same rule on alice does answer.
    const mine = await h.api<{ rule: ApprovalRule }>("POST", `/api/bots/${bot.id}/approval-rules`, {
      matcher: { toolName: "mcp__browser__browser_click" },
      decision: "deny",
    });
    let denied: unknown;
    h.provider.onRun(async (req, gw) => {
      const res = await gw.post("approvals", {
        type: "approval_request",
        runId: req.runId,
        approvalId: "apr-denied",
        action: clickAction("click submit order"),
        riskLevel: "L2",
      });
      denied = { status: res.status, body: await res.json() };
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary("ok"),
        usage: [],
      });
    });
    const run2 = await wake(h, thread.id, "submit it again");
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run2.id).status === "succeeded",
      2000,
      "run2",
    );
    expect(denied).toEqual({
      status: 200,
      body: {
        type: "approval_response",
        approvalId: "apr-denied",
        decision: "deny",
        reason: `Denied by rule ${mine.json.rule.id}`,
      },
    });
  });
});

describe("any member of the thread may decide (A2)", () => {
  async function twoBotThread(): Promise<{
    a: BotDefinition;
    b: BotDefinition;
    thread: Thread;
    workspace: Workspace;
  }> {
    const ws = await h.api<{ workspace: Workspace }>("POST", "/api/workspaces", {
      name: "ws-two",
      egressAllowlist: ["*.example.test"],
    });
    const a = await h.api<{ bot: BotDefinition }>("POST", "/api/bots", {
      name: "ana",
      role: "worker",
      workspaceId: ws.json.workspace.id,
    });
    const b = await h.api<{ bot: BotDefinition }>("POST", "/api/bots", {
      name: "bo",
      role: "approver",
      workspaceId: ws.json.workspace.id,
    });
    const thread = await h.api<{ thread: Thread }>("POST", "/api/threads", {
      workspaceId: ws.json.workspace.id,
      botIds: [a.json.bot.id, b.json.bot.id],
    });
    return {
      a: a.json.bot,
      b: b.json.bot,
      thread: thread.json.thread,
      workspace: ws.json.workspace,
    };
  }

  it("posting a request wakes the other member and not the requester, and that member can decide", async () => {
    const { a, b, thread } = await twoBotThread();
    const sse = await openSse(h.baseUrl);
    const gate = deferred();
    // Bo answers only once the test has seen the requester parked in its live wait; without the
    // gate the whole exchange can finish inside one macrotask and the state is never observable.
    const mayDecide = deferred();
    const seen: StartRunRequest[] = [];
    let decideStatus = 0;

    h.provider.onRun(async (req, gw) => {
      seen.push(req);
      if (req.botId === a.id) {
        if (req.trigger.kind === "approval") {
          await gw.post("ended", {
            type: "run_ended",
            runId: req.runId,
            outcome: "completed",
            summary: summary(""),
            usage: [],
          });
          return;
        }
        await gw.post("approvals", {
          type: "approval_request",
          runId: req.runId,
          approvalId: "apr-two",
          action: clickAction("click submit order"),
          riskLevel: "L2",
        });
        await gate.promise;
        await gw.post("ended", {
          type: "run_ended",
          runId: req.runId,
          outcome: "completed",
          summary: summary("done"),
          usage: [],
        });
        return;
      }
      // Bo's run was woken by the request card; it settles it with `approval_decide`.
      if (decideStatus !== 0) {
        await gw.post("ended", {
          type: "run_ended",
          runId: req.runId,
          outcome: "completed",
          summary: summary(""),
          usage: [],
        });
        return;
      }
      await mayDecide.promise;
      const res = await gw.post("approvals/apr-two/decide", {
        type: "approval_decide",
        runId: req.runId,
        approvalId: "apr-two",
        decision: "allow_once",
      });
      decideStatus = res.status;
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary(""),
        usage: [],
      });
    });

    const aRun = await wake(h, thread.id, "@ana submit the order");
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(aRun.id).status === "waiting_approval_live",
      2000,
      "live wait",
    );
    // The request created exactly one run, for the other member.
    const runsForCard = h.app.deskmates.ctx.runs
      .list({ threadId: thread.id })
      .filter((r) => r.id !== aRun.id);
    expect(runsForCard).toHaveLength(1);
    expect(runsForCard[0]?.botId).toBe(b.id);
    expect(runsForCard[0]?.lane).toBe("interactive");

    mayDecide.resolve();
    await waitFor(() => decideStatus !== 0, 3000, "bot decision");
    expect(decideStatus).toBe(200);
    const approval = h.app.deskmates.ctx.approvals.mustGet("apr-two" as Approval["id"]);
    expect(approval.decidedBy).toBe(`bot:${b.id}`);
    expect(h.app.deskmates.ctx.runs.mustGet(aRun.id).status).toBe("running");

    gate.resolve();
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(aRun.id).status === "succeeded",
      2000,
      "requester end",
    );
    sse.close();
    // `approval_decide` leaves its own trace on the deciding run.
    const bRun = runsForCard[0] as RunRecord;
    expect(h.app.deskmates.ctx.events.list(bRun.id).map((e) => e.payload.phase)).toContain(
      "decided_by_tool",
    );
    // Issue #70: the run API reports the decision beside the run's status, reply or not.
    const bDetail = await h.api<{ run: RunRecord & { visibility: Record<string, boolean> } }>(
      "GET",
      `/api/runs/${bRun.id}`,
    );
    expect(bDetail.json.run.visibility).toMatchObject({
      finalReply: false,
      decidedApproval: true,
      visibleOutcome: true,
    });
    expect([...new Set(seen.map((r) => r.botId))].sort()).toEqual([a.id, b.id].sort());
  });

  it("a bot that is not a member of the approval's thread is rejected", async () => {
    const { a, thread } = await twoBotThread();
    // A third bot in a thread of its own; it is not a member of the request's thread.
    const outsiderWs = await h.api<{ workspace: Workspace }>("POST", "/api/workspaces", {
      name: "ws-outsider",
    });
    const outsider = await h.api<{ bot: BotDefinition }>("POST", "/api/bots", {
      name: "cy",
      role: "nosy",
      workspaceId: outsiderWs.json.workspace.id,
    });
    const outsiderThread = await h.api<{ thread: Thread }>("POST", "/api/threads", {
      workspaceId: outsiderWs.json.workspace.id,
      botIds: [outsider.json.bot.id],
    });

    const sse = await openSse(h.baseUrl);
    const gate = deferred();
    let rejection: { status: number; code: string } | undefined;
    h.provider.onRun(async (req, gw) => {
      if (req.botId === a.id) {
        await gw.post("approvals", {
          type: "approval_request",
          runId: req.runId,
          approvalId: "apr-outsider",
          action: clickAction("click submit order"),
          riskLevel: "L2",
        });
        await gate.promise;
        await gw.post("ended", {
          type: "run_ended",
          runId: req.runId,
          outcome: "completed",
          summary: summary("done"),
          usage: [],
        });
        return;
      }
      if (req.botId === outsider.json.bot.id) {
        const res = await gw.post("approvals/apr-outsider/decide", {
          type: "approval_decide",
          runId: req.runId,
          approvalId: "apr-outsider",
          decision: "allow_once",
        });
        rejection = { status: res.status, code: ((await res.json()) as { code: string }).code };
      }
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary("ok"),
        usage: [],
      });
    });

    const aRun = await wake(h, thread.id, "@ana submit the order");
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(aRun.id).status === "waiting_approval_live",
      2000,
      "live wait",
    );
    await wake(h, outsiderThread.json.thread.id, "decide it for them");
    await waitFor(() => rejection !== undefined, 3000, "rejection");
    // Contracts has no 403-family code for this; the route answers 400 `validation`.
    expect(rejection).toEqual({ status: 400, code: "validation" });
    expect(
      h.app.deskmates.ctx.approvals.mustGet("apr-outsider" as Approval["id"]).decision,
    ).toBeUndefined();
    // A member — here the human — still settles it, which releases the live wait.
    await h.api("POST", "/api/approvals/apr-outsider/decide", { decision: "allow_once" });
    gate.resolve();
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(aRun.id).status === "succeeded",
      2000,
      "end",
    );
    sse.close();
  });
});

describe("operator reads and validation", () => {
  it("lists pending and decided approvals, reads one, and rejects a bad decision", async () => {
    const { bot, thread } = await h.seed();
    const sse = await openSse(h.baseUrl);
    const gate = deferred();
    h.provider.onRun(async (req, gw) => {
      await gw.post("approvals", {
        type: "approval_request",
        runId: req.runId,
        approvalId: "apr-list",
        action: clickAction("click submit order"),
        riskLevel: "L2",
      });
      await gate.promise;
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary("ok"),
        usage: [],
      });
    });
    const run = await wake(h, thread.id, "submit it");
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "waiting_approval_live",
      2000,
      "live",
    );

    const pending = await h.api<{ approvals: Approval[] }>("GET", "/api/approvals");
    expect(pending.json.approvals.map((a) => a.id)).toEqual(["apr-list"]);
    const byThread = await h.api<{ approvals: Approval[] }>(
      "GET",
      `/api/approvals?status=pending&threadId=${thread.id}&botId=${bot.id}`,
    );
    expect(byThread.json.approvals).toHaveLength(1);
    const one = await h.api<{ approval: Approval }>("GET", "/api/approvals/apr-list");
    expect(one.json.approval.instruction).toBe("submit it");
    expect(one.json.approval.toolUseId).toBeUndefined();

    const bad = await h.api<{ code: string }>("POST", "/api/approvals/apr-list/decide", {
      decision: "maybe",
    });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe("validation");

    const missing = await h.api<{ code: string }>("GET", "/api/approvals/apr-nope");
    expect(missing.status).toBe(404);

    await h.api("POST", "/api/approvals/apr-list/decide", { decision: "allow_once" });
    const decided = await h.api<{ approvals: Approval[] }>("GET", "/api/approvals?status=decided");
    expect(decided.json.approvals.map((a) => a.id)).toEqual(["apr-list"]);
    expect(await h.api<{ approvals: Approval[] }>("GET", "/api/approvals")).toMatchObject({
      json: { approvals: [] },
    });

    gate.resolve();
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded",
      2000,
      "end",
    );
    sse.close();
    // The decision echo carries the approval attachment so the UI can update the card.
    const echo = h.app.deskmates.ctx.messages
      .list(thread.id)
      .filter((m) => m.authorKind === "system")
      .at(-1) as ThreadMessage;
    expect(echo.body).toBe("Approved by human:web");
    expect(echo.attachments[0]?.ref).toBe("apr-list");
  });

  it("rejects a non-L2 request and a rule with a wrong-typed matcher field", async () => {
    const { bot, thread } = await h.seed();
    let tier: { status: number; code: string } | undefined;
    h.provider.onRun(async (req, gw) => {
      const res = await gw.post("approvals", {
        type: "approval_request",
        runId: req.runId,
        approvalId: "apr-l1",
        action: clickAction("click submit order"),
        riskLevel: "L1",
      });
      tier = { status: res.status, code: ((await res.json()) as { code: string }).code };
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary("ok"),
        usage: [],
      });
    });
    const run = await wake(h, thread.id, "click about");
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded",
      2000,
      "run",
    );
    // L0 and L1 never reach the broker; a sidecar that sends one is misbehaving.
    expect(tier).toEqual({ status: 400, code: "validation" });

    const badMatcher = await h.api<{ code: string }>("POST", `/api/bots/${bot.id}/approval-rules`, {
      matcher: { toolName: 7 },
      decision: "allow_always",
    });
    expect(badMatcher.status).toBe(400);
    const badDecision = await h.api<{ code: string }>(
      "POST",
      `/api/bots/${bot.id}/approval-rules`,
      { matcher: {}, decision: "allow_once" },
    );
    expect(badDecision.status).toBe(400);
    expect(
      (await h.api<{ rules: ApprovalRule[] }>("GET", `/api/bots/${bot.id}/approval-rules`)).json
        .rules,
    ).toEqual([]);
  });
});
