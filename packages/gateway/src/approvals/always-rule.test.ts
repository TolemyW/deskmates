// T1, ADR-0002 amendment 3, A6: an Always decision stores the tool plus a stable target, never
// the displayed summary; the human's edit is stored as edited; a truncated pattern, a matcher that
// does not match the answered action and an action with no stable target are refused with a typed
// error and leave the request pending; an exact free-text pattern is stored with a warning; and a
// second request with the same target asks nobody. Rules stored before A6 keep matching.

import type {
  ApprovalId,
  ApprovalRequest,
  ApprovalRule,
  BotId,
  RunId,
  ThreadId,
  ToolAction,
} from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunRecord } from "../ledger/runs.js";
import { type Harness, startHarness } from "../test-support/harness.js";

let h: Harness;
let botId: BotId;
let threadId: ThreadId;

beforeEach(async () => {
  h = await startHarness();
  const seeded = await h.seed();
  botId = seeded.bot.id;
  threadId = seeded.thread.id;
});

afterEach(async () => {
  await h.close();
});

const PUSH: ToolAction = {
  toolName: "Bash",
  input: { command: "git push origin feature/a" },
  argumentSummary: "git push origin feature/a",
  argumentPattern: "git push*",
};

const SPAWN: ToolAction = {
  toolName: "Agent",
  input: { subagent_type: "Explore", description: "map the repo", prompt: "long" },
  argumentSummary: "agent Explore: map the repo",
  argumentPattern: "agent Explore: *",
};

let seq = 0;

/**
 * A run that asks is executing. Left queued, the scheduler would start it, the fake sidecar would
 * exit without a `run_ended`, and the failed run's pending approvals would close (issue #61 M6).
 */
function newRun(): RunRecord {
  const ctx = h.app.deskmates.ctx;
  const run = ctx.runs.create({
    botId,
    threadId,
    lane: "interactive",
    triggerKind: "thread_message",
    triggerRef: "msg-none",
    config: ctx.runConfig(),
  });
  return ctx.runs.transition(run.id, "running");
}

/** One L2 request through the real broker; returns its id and whether a rule answered it. */
function ask(action: ToolAction): { id: ApprovalId; rule: boolean } {
  const ctx = h.app.deskmates.ctx;
  const run = newRun();
  seq += 1;
  const id = `apr-a6-${seq}` as ApprovalId;
  const request: ApprovalRequest = {
    type: "approval_request",
    runId: run.id as RunId,
    approvalId: id,
    action,
    riskLevel: "L2",
  };
  const answer = ctx.broker.request(run, request);
  const approval = ctx.approvals.mustGet(id);
  return { id, rule: answer !== "pending" && approval.decidedBy?.startsWith("rule:") === true };
}

type Decided = { rule?: ApprovalRule; warnings?: string[] };
type Refused = { code: string; details: { reason?: string } };

function decide(id: ApprovalId, body: Record<string, unknown>) {
  return h.api<Decided & Refused>("POST", `/api/approvals/${id}/decide`, body);
}

describe("Always from a stable target (A6)", () => {
  it("stores the program and subcommand, and a later push elsewhere asks nobody", async () => {
    const first = ask(PUSH);
    expect(first.rule).toBe(false);
    const decided = await decide(first.id, { decision: "allow_always" });
    expect(decided.status).toBe(200);
    expect(decided.json.rule?.matcher).toEqual({ toolName: "Bash", argumentPattern: "git push*" });
    expect(decided.json.warnings).toBeUndefined();

    const posted = h.app.deskmates.ctx.messages.list(threadId).length;
    const second = ask({
      ...PUSH,
      input: { command: "git push origin feature/b --tags" },
      argumentSummary: "git push origin feature/b --tags",
    });
    expect(second.rule).toBe(true);
    // Answered by the rule: nothing posted, nobody asked.
    expect(h.app.deskmates.ctx.messages.list(threadId).length).toBe(posted);
  });

  it("holds for a subagent spawn: another description of the same type asks nobody", async () => {
    const first = ask(SPAWN);
    const decided = await decide(first.id, { decision: "allow_always" });
    expect(decided.json.rule?.matcher).toEqual({
      toolName: "Agent",
      argumentPattern: "agent Explore: *",
    });
    expect(ask({ ...SPAWN, argumentSummary: "agent Explore: find the tests" }).rule).toBe(true);
    expect(ask({ ...SPAWN, argumentSummary: "agent general-purpose: x" }).rule).toBe(false);
  });

  it("stores a file tool's directory prefix and a free-text tool's input hash", async () => {
    const write = ask({
      toolName: "Write",
      input: { file_path: "/srv/site/index.html" },
      filePath: "/srv/site/index.html",
      argumentSummary: "/srv/site/index.html",
    });
    const w = await decide(write.id, { decision: "allow_always" });
    expect(w.json.rule?.matcher).toEqual({ toolName: "Write", filePath: "/srv/site/" });

    const send = ask({
      toolName: "SendMessage",
      input: { to: "peer", message: "hello" },
      argumentSummary: '{"to":"peer","message":"hello"}',
      inputSha256: "c".repeat(64),
    });
    const s = await decide(send.id, { decision: "allow_always" });
    expect(s.json.rule?.matcher).toEqual({ toolName: "SendMessage", inputSha256: "c".repeat(64) });
    expect(s.json.warnings).toEqual(["exact_input"]);
  });

  it("stores the human's edit as edited", async () => {
    const first = ask(PUSH);
    const edited = { toolName: "Bash", argumentPattern: "git *" };
    const decided = await decide(first.id, { decision: "allow_always", matcher: edited });
    expect(decided.status).toBe(200);
    expect(decided.json.rule?.matcher).toEqual(edited);
  });

  it("refuses a truncated pattern and a matcher that does not match, leaving the request pending", async () => {
    const first = ask(PUSH);
    const truncated = await decide(first.id, {
      decision: "allow_always",
      matcher: { toolName: "Bash", argumentPattern: "git push origin feat…" },
    });
    expect(truncated.status).toBe(400);
    expect(truncated.json).toMatchObject({
      code: "validation",
      details: { reason: "rule_pattern_truncated" },
    });
    const mismatch = await decide(first.id, {
      decision: "allow_always",
      matcher: { toolName: "Bash", argumentPattern: "npm publish*" },
    });
    expect(mismatch.status).toBe(400);
    expect(mismatch.json.details.reason).toBe("rule_does_not_match_action");
    const ctx = h.app.deskmates.ctx;
    expect(ctx.approvals.mustGet(first.id).decision).toBeUndefined();
    expect(ctx.rules.list(botId)).toEqual([]);
  });

  it("warns on an exact free-text pattern, which matches only this action again", async () => {
    const first = ask(PUSH);
    const decided = await decide(first.id, {
      decision: "allow_always",
      matcher: { toolName: "Bash", argumentPattern: "git push origin feature/a" },
    });
    expect(decided.status).toBe(200);
    expect(decided.json.warnings).toEqual(["exact_arguments"]);
  });

  it("refuses Always for an action with no stable target unless the human writes the matcher", async () => {
    const legacy = ask({ toolName: "SendMessage", input: {}, argumentSummary: "{}" });
    const refused = await decide(legacy.id, { decision: "allow_always" });
    expect(refused.status).toBe(400);
    expect(refused.json.details.reason).toBe("rule_no_stable_target");
    const written = await decide(legacy.id, {
      decision: "allow_always",
      matcher: { toolName: "SendMessage" },
    });
    expect(written.status).toBe(200);
  });

  it("refuses a matcher on a decision that stores no rule", async () => {
    const first = ask(PUSH);
    const once = await decide(first.id, { decision: "allow_once", matcher: { toolName: "Bash" } });
    expect(once.status).toBe(400);
  });

  it("keeps matching a rule stored before A6 from the verbatim summary", () => {
    const ctx = h.app.deskmates.ctx;
    ctx.rules.create({
      botId,
      matcher: { toolName: "Bash", argumentPattern: "git push origin feature/a" },
      decision: "allow_always",
      createdBy: "human:web",
    });
    // As an action recorded before A6, with no stable pattern.
    const { argumentPattern: _pattern, ...legacy } = PUSH;
    expect(ask(legacy).rule).toBe(true);
  });
});

describe("rule routes check the matcher too (A6)", () => {
  it("refuses a truncated pattern and warns on an exact one, on create and on edit", async () => {
    const path = `/api/bots/${botId}/approval-rules`;
    const truncated = await h.api<Refused>("POST", path, {
      decision: "allow_always",
      matcher: { toolName: "Bash", argumentPattern: "git commit -m a long messa…" },
    });
    expect(truncated.status).toBe(400);
    expect(truncated.json.details.reason).toBe("rule_pattern_truncated");

    const exact = await h.api<Decided>("POST", path, {
      decision: "allow_always",
      matcher: { toolName: "Bash", argumentPattern: "make deploy" },
    });
    expect(exact.status).toBe(201);
    expect(exact.json.warnings).toEqual(["exact_arguments"]);

    const ruleId = exact.json.rule?.id ?? "";
    const wild = await h.api<Decided>("PATCH", `/api/approval-rules/${ruleId}`, {
      matcher: { toolName: "Bash", argumentPattern: "make deploy*" },
    });
    expect(wild.status).toBe(200);
    expect(wild.json.warnings).toBeUndefined();
    const bad = await h.api<Refused>("PATCH", `/api/approval-rules/${ruleId}`, {
      matcher: { toolName: "Bash", argumentPattern: "make deplo…" },
    });
    expect(bad.status).toBe(400);
  });
});
