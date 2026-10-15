// T1: a threadless run's approvals reach a human (ADR-0002 amendment 3, A9). A cron run's tool
// request and its continuation request are each posted, routing-inert, in the bot's private chat
// and appear in the pending inbox; the run itself stays threadless.

import {
  type Approval,
  type ApprovalId,
  type BotDefinition,
  type RunEnded,
  type StartRunRequest,
  isApprovalAttachmentMime,
} from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunRecord } from "../ledger/runs.js";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

const ctx = () => h.app.deskmates.ctx;

function cronRun(bot: BotDefinition): RunRecord {
  const run = ctx().runs.create({
    botId: bot.id,
    lane: "background",
    triggerKind: "cron",
    triggerRef: "cron:test",
    triggerPayload: { prompt: "nightly report" },
    config: ctx().runConfig(),
  });
  h.app.deskmates.scheduler.kick();
  return run;
}

function noticesIn(threadId: string) {
  return ctx()
    .messages.list(threadId as never)
    .filter((m) => m.attachments.some((a) => isApprovalAttachmentMime(a.mimeType)));
}

describe("threadless approvals (ADR-0002 amendment 3, A9)", () => {
  it("posts a cron run's tool request in the bot's private chat, waking nobody", async () => {
    const { bot } = await h.seed();
    h.provider.onRun(async (req: StartRunRequest, gw) => {
      if (req.trigger.kind === "approval") return undefined;
      await gw.post("approvals", {
        type: "approval_request",
        runId: req.runId,
        approvalId: "apr-cron",
        action: { toolName: "Bash", input: { command: "git push" }, argumentSummary: "git push" },
        riskLevel: "L2",
        toolUseId: "toolu_cron",
      });
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "deferred",
        sdkSessionId: "sess-cron",
        usage: [],
        pendingApprovalId: "apr-cron",
        pendingToolUseId: "toolu_cron",
      });
      return undefined;
    });
    const run = cronRun(bot);
    await waitFor(
      () => ctx().runs.mustGet(run.id).status === "waiting_approval",
      3000,
      "parked cron run",
    );
    const chat = ctx().privateChats.existing(bot.id);
    if (!chat) throw new Error("no private chat");
    const approval = ctx().approvals.mustGet("apr-cron" as ApprovalId);
    expect(approval.threadId).toBe(chat.id);
    expect(ctx().runs.mustGet(run.id).threadId).toBeUndefined();
    const notices = noticesIn(chat.id);
    expect(notices).toHaveLength(1);
    expect(approval.messageId).toBe(notices[0]?.id);
    expect(ctx().runs.list({ threadId: chat.id })).toEqual([]);
    expect(
      ctx()
        .approvals.list({ status: "pending" })
        .map((a: Approval) => a.id),
    ).toContain("apr-cron");
  });

  it("posts a cron run's continuation request in the bot's private chat", async () => {
    const { bot } = await h.seed();
    h.provider.onRun(async (req, gw) => {
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "turns_exhausted",
        sdkSessionId: "sess-cron",
        usage: [],
        handoffPath: "/work/handoffs/h.md",
      } as RunEnded);
      return undefined;
    });
    const run = cronRun(bot);
    await waitFor(
      () => ctx().runs.mustGet(run.id).status === "waiting_continuation",
      3000,
      "continuation park",
    );
    const chat = ctx().privateChats.existing(bot.id);
    if (!chat) throw new Error("no private chat");
    const approvalId = ctx().runs.mustGet(run.id).resumePayload?.approvalId as ApprovalId;
    const approval = ctx().approvals.mustGet(approvalId);
    expect(approval.kind).toBe("continuation");
    expect(approval.threadId).toBe(chat.id);
    expect(noticesIn(chat.id).map((m) => m.id)).toEqual([approval.messageId]);
    expect(ctx().runs.list({ threadId: chat.id })).toEqual([]);
  });
});
