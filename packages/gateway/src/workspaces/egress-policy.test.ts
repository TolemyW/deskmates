// T1: ADR-0020. A workspace created without a list browses the open internet; an egress
// approval answered "allow this site" grows the allowlist before the run continues and creates
// no tool rule; allow_once is refused for it; deny leaves the list alone.

import type { Approval, BotDefinition, RunSummary, Thread, Workspace } from "@deskmates/contracts";
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

async function wake(threadId: string, body: string): Promise<RunRecord> {
  const m = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${threadId}/messages`, {
    body,
  });
  const run = m.json.runs[0];
  if (!run) throw new Error("no run created");
  return run;
}

function egressRequest(approvalId: string, host: string, runId: string) {
  return {
    type: "approval_request",
    runId,
    approvalId,
    kind: "egress",
    riskLevel: "L2",
    toolUseId: `toolu_${approvalId}`,
    action: {
      toolName: "mcp__browser__browser_navigate",
      input: { url: `https://${host}/page` },
      targetOrigin: `https://${host}`,
      argumentSummary: `open https://${host}/page`,
      argumentPattern: host,
    },
  };
}

describe("workspace creation default (decision 1)", () => {
  it("a workspace created without a list is open internet; an explicit list, empty included, is kept", async () => {
    const open = await h.api<{ workspace: Workspace }>("POST", "/api/workspaces", {
      name: "research",
    });
    expect(open.status).toBe(201);
    expect(open.json.workspace.egressAllowlist).toEqual(["*"]);
    const locked = await h.api<{ workspace: Workspace }>("POST", "/api/workspaces", {
      name: "ops",
      egressAllowlist: [],
    });
    expect(locked.json.workspace.egressAllowlist).toEqual([]);
  });
});

describe("egress approvals (decision 2)", () => {
  async function askedFor(host: string): Promise<{
    bot: BotDefinition;
    thread: Thread;
    workspace: Workspace;
    approvalId: string;
  }> {
    const { bot, thread, workspace } = await h.seed();
    const approvalId = `apr-${host.replace(/\W/g, "")}`;
    h.provider.onRun(async (req, gw) => {
      // The decision resumes the parked run; that attempt simply finishes.
      if (req.trigger.kind === "approval") {
        await gw.post("ended", {
          type: "run_ended",
          runId: req.runId,
          outcome: "completed",
          summary: summary("done"),
          usage: [],
        });
        return;
      }
      await gw.post("approvals", egressRequest(approvalId, host, req.runId));
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "deferred",
        sdkSessionId: "sess-egress",
        usage: [],
        pendingApprovalId: approvalId,
        pendingToolUseId: `toolu_${approvalId}`,
      });
    });
    await wake(thread.id, `read ${host}`);
    await waitFor(
      () => h.app.deskmates.ctx.approvals.get(approvalId as never) !== undefined,
      2000,
      "ask",
    );
    return { bot, thread, workspace, approvalId };
  }

  it("allow this site adds the host to the workspace allowlist and stores no rule", async () => {
    const { bot, workspace, approvalId } = await askedFor("docs.databricks.com");
    const stored = h.app.deskmates.ctx.approvals.mustGet(approvalId as never);
    expect(stored.kind).toBe("egress");
    const decided = await h.api<{ approval: Approval; rule?: unknown }>(
      "POST",
      `/api/approvals/${approvalId}/decide`,
      { decision: "allow_always", authorId: "ops" },
    );
    expect(decided.status).toBe(200);
    expect(decided.json.approval.decision).toBe("allow_always");
    expect(decided.json.rule).toBeUndefined();
    const after = await h.api<{ workspace: Workspace }>("GET", `/api/workspaces/${workspace.id}`);
    expect(after.json.workspace.egressAllowlist).toEqual(["*.example.test", "docs.databricks.com"]);
    const rules = await h.api<{ rules: unknown[] }>("GET", `/api/bots/${bot.id}/approval-rules`);
    expect(rules.json.rules).toEqual([]);
  });

  it("refuses allow_once for an egress ask, and a deny leaves the list unchanged", async () => {
    const { workspace, approvalId } = await askedFor("news.example.org");
    const once = await h.api("POST", `/api/approvals/${approvalId}/decide`, {
      decision: "allow_once",
      authorId: "ops",
    });
    expect(once.status).toBe(400);
    const denied = await h.api<{ approval: Approval }>(
      "POST",
      `/api/approvals/${approvalId}/decide`,
      { decision: "deny", authorId: "ops", reason: "not that site" },
    );
    expect(denied.status).toBe(200);
    const after = await h.api<{ workspace: Workspace }>("GET", `/api/workspaces/${workspace.id}`);
    expect(after.json.workspace.egressAllowlist).toEqual(["*.example.test"]);
  });
});
