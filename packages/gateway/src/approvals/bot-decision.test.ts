// T1: no self-approval (ADR-0002 amendment 3, A10) through the real stores and router on an
// in-memory database: who may settle an approval, read from the requesting run's wake chain.

import { type ApprovalId, DeskmatesError, type ToolAction } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { buildContext } from "../context.js";
import { type GatewayDb, openDatabase } from "../db/open.js";
import type { RunRecord } from "../ledger/runs.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { testConfig } from "../test-support/harness.js";
import { assertBotMayDecide } from "./bot-decision.js";

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

  let n = 0;
  const request = (run: RunRecord, kind?: "egress" | "continuation") =>
    ctx.approvals.create({
      id: `apr-${++n}` as ApprovalId,
      runId: run.id,
      botId: run.botId,
      threadId: thread.id,
      action: kind === "continuation" ? { toolName: "__run_continuation__", input: {} } : PUSH,
      riskLevel: kind === "continuation" ? "L0" : "L2",
      ...(kind === "egress" ? { kind } : {}),
    });
  return { ctx, chief, expert, reviewer, thread, chiefRun, expertRun, request };
}

function refusal(fn: () => void): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    if (!(err instanceof DeskmatesError)) throw err;
    expect(err.code).toBe("forbidden");
    return String((err.details as { refusal?: unknown } | undefined)?.refusal);
  }
}

describe("no self-approval (ADR-0002 amendment 3, A10)", () => {
  it("refuses the requesting bot deciding its own tool request", () => {
    const { ctx, expert, expertRun, request } = setup();
    const approval = request(expertRun);
    expect(refusal(() => assertBotMayDecide(ctx, approval, expert.id, "allow_once"))).toBe(
      "self_approval",
    );
    expect(refusal(() => assertBotMayDecide(ctx, approval, expert.id, "deny"))).toBe(
      "self_approval",
    );
  });

  it("refuses the delegator deciding its delegate's tool request", () => {
    const { ctx, chief, expertRun, request } = setup();
    const approval = request(expertRun);
    expect(refusal(() => assertBotMayDecide(ctx, approval, chief.id, "allow_once"))).toBe(
      "delegator_approval",
    );
    // An egress ask is refused the same way.
    const egress = request(expertRun, "egress");
    expect(refusal(() => assertBotMayDecide(ctx, egress, chief.id, "deny"))).toBe(
      "delegator_approval",
    );
  });

  it("lets the delegator decide its delegate's continuation request (ADR-0016 decision 3)", () => {
    const { ctx, chief, expert, expertRun, request } = setup();
    const continuation = request(expertRun, "continuation");
    expect(continuation.kind).toBe("continuation");
    expect(refusal(() => assertBotMayDecide(ctx, continuation, chief.id, "allow_once"))).toBe(
      undefined,
    );
    expect(refusal(() => assertBotMayDecide(ctx, continuation, chief.id, "deny"))).toBe(undefined);
    // The exhausted bot still cannot continue itself.
    expect(refusal(() => assertBotMayDecide(ctx, continuation, expert.id, "allow_once"))).toBe(
      "self_approval",
    );
  });

  it("refuses allow_always from any bot, for a tool request and for an egress ask", () => {
    const { ctx, reviewer, expertRun, request } = setup();
    expect(
      refusal(() => assertBotMayDecide(ctx, request(expertRun), reviewer.id, "allow_always")),
    ).toBe("bot_allow_always");
    expect(
      refusal(() =>
        assertBotMayDecide(ctx, request(expertRun, "egress"), reviewer.id, "allow_always"),
      ),
    ).toBe("bot_allow_always");
  });

  it("lets a member that is neither requester nor upstream decide allow_once or deny", () => {
    const { ctx, reviewer, expertRun, request } = setup();
    const approval = request(expertRun);
    expect(refusal(() => assertBotMayDecide(ctx, approval, reviewer.id, "allow_once"))).toBe(
      undefined,
    );
    expect(refusal(() => assertBotMayDecide(ctx, approval, reviewer.id, "deny"))).toBe(undefined);
  });

  it("does not take a delegate that reported back up the chain for the delegator", () => {
    const { ctx, chief, expert, thread, expertRun, request } = setup();
    // The expert reports "done @chief"; the chief's run woken by that report asks for approval.
    ctx.router.postFromRun(expertRun, "@chief pushed, please verify");
    const chiefAgain = ctx.runs.findQueued(chief.id, thread.id) as RunRecord;
    expect(chiefAgain).toBeDefined();
    const approval = request(chiefAgain);
    expect(refusal(() => assertBotMayDecide(ctx, approval, expert.id, "allow_once"))).toBe(
      undefined,
    );
  });
});
