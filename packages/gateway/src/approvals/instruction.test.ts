// T1: approval notices are routing-inert and never an instruction (ADR-0002 amendment 3, A4),
// through the real stores, router and broker on an in-memory database.

import { type ApprovalId, type ToolAction, isApprovalAttachmentMime } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { buildContext } from "../context.js";
import { type GatewayDb, openDatabase } from "../db/open.js";
import type { RunRecord } from "../ledger/runs.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { testConfig } from "../test-support/harness.js";
import { cardInstruction } from "./instruction.js";

const databases: GatewayDb[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const PUSH: ToolAction = {
  toolName: "Bash",
  input: { command: "git push" },
  argumentSummary: "git push",
};

/** A human asks the chief; the chief delegates to the expert by mention; a reviewer is in too. */
function setup() {
  const db = openDatabase(":memory:");
  databases.push(db);
  const ctx = buildContext(testConfig(), db, new FakeProvider(), () => "http://gateway.test");
  const ws = ctx.workspaces.create({ name: "qa", sandboxProvider: "docker" });
  const chief = ctx.bots.create({ name: "chief", role: "coordinator", workspaceId: ws.id });
  const expert = ctx.bots.create({ name: "expert", role: "worker", workspaceId: ws.id });
  const reviewer = ctx.bots.create({ name: "reviewer", role: "security", workspaceId: ws.id });
  const thread = ctx.threads.create({
    workspaceId: ws.id,
    botIds: [chief.id, expert.id, reviewer.id],
  });
  const human = ctx.router.postHuman({ threadId: thread.id, body: "@chief ship ticket 1050" });
  const chiefRun = human.runs[0] as RunRecord;
  ctx.runs.transition(chiefRun.id, "running", { deliveredSeq: human.message.seq });
  const delegation = ctx.router.postFromRun(chiefRun, "@expert push the fix for 1050");
  const expertRun = ctx.runs.findQueued(expert.id, thread.id) as RunRecord;
  ctx.runs.transition(expertRun.id, "running", { deliveredSeq: delegation.seq });
  return { ctx, chief, expert, reviewer, thread, chiefRun, expertRun };
}

describe("approval notices are routing-inert (ADR-0002 amendment 3, A4)", () => {
  it("an approval notice wakes nobody in a three-member thread", () => {
    const { ctx, thread, expertRun } = setup();
    const before = ctx.runs.list({ threadId: thread.id }).map((run) => run.id);
    const answer = ctx.broker.request(ctx.runs.mustGet(expertRun.id), {
      type: "approval_request",
      runId: expertRun.id,
      approvalId: "apr-inert" as ApprovalId,
      action: PUSH,
      riskLevel: "L2",
    });
    // Nobody online: the requester parks; nothing else happens.
    expect(answer).toMatchObject({ decision: "defer" });
    expect(ctx.runs.list({ threadId: thread.id }).map((run) => run.id)).toEqual(before);
    const notice = ctx.messages
      .list(thread.id)
      .find((m) => m.attachments.some((a) => isApprovalAttachmentMime(a.mimeType)));
    expect(notice?.authorKind).toBe("system");
    // The card's instruction is the human's, not the chief's delegation line.
    expect(ctx.approvals.mustGet("apr-inert" as ApprovalId).instruction).toBe(
      "@chief ship ticket 1050",
    );

    // The decision echo wakes nobody either.
    ctx.broker.decide("apr-inert" as ApprovalId, "deny", "human:alice");
    expect(ctx.runs.list({ threadId: thread.id }).map((run) => run.id)).toEqual(before);
  });

  it("follows the wake chain past system notices that name a run", () => {
    const { ctx, thread, chief, expertRun } = setup();
    // An outcome notice about the expert's run wakes the chief.
    const outcome = ctx.router.postSystem(thread.id, "expert finished", [], {
      runId: expertRun.id,
      wakeOnly: chief.id,
    });
    const woken = outcome.runs[0] as RunRecord;
    expect(woken.botId).toBe(chief.id);
    expect(cardInstruction(ctx, woken)).toBe("@chief ship ticket 1050");
  });

  it("shows the waking bot message when no human started the work, and never a notice", () => {
    const { ctx, thread, chief, expert } = setup();
    const bare = ctx.router.postSystem(thread.id, "Approval needed: something", [], {
      wakeOnly: expert.id,
    });
    expect(cardInstruction(ctx, bare.runs[0] as RunRecord)).toBeUndefined();
    const cron = ctx.runs.create({
      botId: chief.id,
      lane: "background",
      triggerKind: "cron",
      triggerRef: "nightly",
      config: {},
    });
    expect(cardInstruction(ctx, cron)).toBeUndefined();
  });
});
