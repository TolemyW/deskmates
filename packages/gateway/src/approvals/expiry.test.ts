// T1: unattended approval requests expire to deny, after one reminder to humans (ADR-0002
// amendment 3, A7 and A8). The fake provider plays the sidecar; the sweep is driven with an
// explicit clock instead of waiting fifteen minutes.

import {
  type ApprovalId,
  type RunSummary,
  type StartRunRequest,
  type WorkspaceId,
  isApprovalAttachmentMime,
} from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunRecord } from "../ledger/runs.js";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";
import { AutoApprovalSettings } from "./auto-approval.js";
import { APPROVAL_EXPIRY_ACTOR, ApprovalExpiry, expiryReason } from "./expiry.js";

let h: Harness;
let resumed: StartRunRequest[];
beforeEach(async () => {
  resumed = [];
  h = await startHarness();
  h.provider.onRun(async (req, gw) => {
    if (req.trigger.kind === "approval") {
      resumed.push(req);
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary("reported what is blocked"),
        usage: [],
      });
      return undefined;
    }
    await gw.post("approvals", {
      type: "approval_request",
      runId: req.runId,
      approvalId: "apr-exp",
      action: { toolName: "Bash", input: { command: "git push" }, argumentSummary: "git push" },
      riskLevel: "L2",
      toolUseId: "toolu_exp",
    });
    await gw.post("ended", {
      type: "run_ended",
      runId: req.runId,
      outcome: "deferred",
      sdkSessionId: "sess-exp",
      usage: [],
      pendingApprovalId: "apr-exp",
      pendingToolUseId: "toolu_exp",
    });
    return undefined;
  });
});
afterEach(async () => {
  await h.close();
});

const ctx = () => h.app.deskmates.ctx;
const APPROVAL = "apr-exp" as ApprovalId;
const minutes = (n: number) => n * 60_000;

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

async function parkedRequest(): Promise<{ run: RunRecord; threadId: string; t0: number }> {
  const { thread } = await h.seed();
  const posted = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${thread.id}/messages`, {
    body: "push the fix",
  });
  const run = posted.json.runs[0] as RunRecord;
  await waitFor(() => ctx().runs.mustGet(run.id).status === "waiting_approval", 3000, "parked");
  return { run, threadId: thread.id, t0: Date.parse(ctx().approvals.mustGet(APPROVAL).createdAt) };
}

describe("unattended approvals (ADR-0002 amendment 3, A7 and A8)", () => {
  it("reminds once, then expires to deny and resumes the run once with the fixed text", async () => {
    const { run, threadId, t0 } = await parkedRequest();
    const sweep = new ApprovalExpiry(ctx());
    const runsBefore = ctx()
      .runs.list({ threadId: threadId as never })
      .map((r) => r.id);

    // Amendment 6, D7: a 60-minute window. Before two thirds of it nothing happens.
    expect(sweep.sweep(new Date(t0 + minutes(39)))).toEqual({ expired: [], reminded: [] });
    // A8: one reminder at 40 minutes, routing-inert, carrying the approval attachment.
    expect(sweep.sweep(new Date(t0 + minutes(40)))).toEqual({ expired: [], reminded: [APPROVAL] });
    expect(sweep.sweep(new Date(t0 + minutes(50)))).toEqual({ expired: [], reminded: [] });
    const reminders = ctx()
      .messages.list(threadId as never)
      .filter((m) => m.body.startsWith("Reminder:"));
    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.attachments.some((a) => isApprovalAttachmentMime(a.mimeType))).toBe(true);
    expect(
      ctx()
        .runs.list({ threadId: threadId as never })
        .map((r) => r.id),
    ).toEqual(runsBefore);
    expect(ctx().approvals.mustGet(APPROVAL).decision).toBeUndefined();

    // A7: at the deadline the request is denied by nobody, and the hook's text says so.
    expect(sweep.sweep(new Date(t0 + minutes(59)))).toEqual({ expired: [], reminded: [] });
    expect(sweep.sweep(new Date(t0 + minutes(60)))).toEqual({ expired: [APPROVAL], reminded: [] });
    const expired = ctx().approvals.mustGet(APPROVAL);
    expect(expired).toMatchObject({ decision: "deny", decidedBy: APPROVAL_EXPIRY_ACTOR });
    expect(ctx().broker.response(expired)).toMatchObject({
      decision: "deny",
      reason: expiryReason(60),
    });
    expect(expiryReason(60)).toContain("Nobody approved this within 60 minutes. It was not done.");
    const phases = ctx()
      .events.list(run.id)
      .filter((e) => e.kind === "approval")
      .map((e) => e.payload.phase);
    expect(phases).toEqual(expect.arrayContaining(["reminded", "decided", "expired"]));
    expect(
      ctx()
        .messages.list(threadId as never)
        .some((m) => m.body.startsWith("Expired by system:expiry")),
    ).toBe(true);

    h.app.deskmates.scheduler.kick();
    await waitFor(() => ctx().runs.mustGet(run.id).status === "succeeded", 3000, "resumed");
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.trigger).toMatchObject({
      kind: "approval",
      decision: "deny",
      reason: expiryReason(60),
    });
    // A later sweep finds nothing to do.
    expect(sweep.sweep(new Date(t0 + minutes(240)))).toEqual({ expired: [], reminded: [] });
  });

  it("uses the workspace's own window", async () => {
    const { t0 } = await parkedRequest();
    const approval = ctx().approvals.mustGet(APPROVAL);
    const workspaceId = ctx().bots.mustGet(approval.botId).workspaceId as WorkspaceId;
    new AutoApprovalSettings(ctx().db).change(workspaceId, { expiryMinutes: 3 }, "human:test");
    const sweep = new ApprovalExpiry(ctx());
    expect(sweep.sweep(new Date(t0 + minutes(2)))).toEqual({ expired: [], reminded: [APPROVAL] });
    expect(sweep.sweep(new Date(t0 + minutes(3)))).toEqual({ expired: [APPROVAL], reminded: [] });
    expect(ctx().approvals.mustGet(APPROVAL).reason).toBe(expiryReason(3));
  });

  it("leaves a continuation request to its 24-hour window", async () => {
    const { run, t0 } = await parkedRequest();
    ctx().broker.decide(APPROVAL, "allow_once", "human:test");
    const continuation = ctx().approvals.create({
      id: "apr-cont" as ApprovalId,
      runId: run.id,
      botId: run.botId,
      action: { toolName: "__run_continuation__", input: {} },
      riskLevel: "L0",
    });
    expect(continuation.kind).toBe("continuation");
    const swept = new ApprovalExpiry(ctx()).sweep(new Date(t0 + minutes(240)));
    expect(swept).toEqual({ expired: [], reminded: [] });
    expect(ctx().approvals.mustGet("apr-cont" as ApprovalId).decision).toBeUndefined();
  });
});
