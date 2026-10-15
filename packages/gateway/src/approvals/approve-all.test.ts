// T1, ADR-0002 amendment 6 D4 and D5: in `approve_all` every gated action is allowed without
// asking anyone, recorded as `mode:approve_all`; an egress ask adds its host through the existing
// allowlist writer; a host that is not a public hostname still goes to humans; a stored deny rule
// still answers first; the stored action is still scrubbed of secrets.

import {
  APPROVAL_MODE_ACTOR,
  type ApprovalId,
  type ApprovalResponse,
  type RunSummary,
  type StartRunRequest,
} from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunRecord } from "../ledger/runs.js";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";
import { APPROVAL_REVIEW } from "./auto-review.js";

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

const bash = (command: string) => ({
  toolName: "Bash",
  input: { command },
  argumentSummary: command,
  argumentPattern: `${command.split(" ").slice(0, 2).join(" ")}*`,
});

const egress = (host: string) => ({
  toolName: "mcp__browser__browser_navigate",
  input: { url: `https://${host}/page` },
  targetOrigin: `https://${host}`,
  argumentSummary: `open https://${host}/page`,
  argumentPattern: host,
});

interface Ask {
  action: Record<string, unknown>;
  kind?: "egress";
}

/** Seeds an approve-all workspace, lets the fake sidecar post each ask once, and ends the run. */
async function run(asks: Ask[], before?: (botId: string) => void) {
  const { workspace, thread, bot } = await h.seed({ approvalMode: "approve_all" });
  before?.(bot.id);
  const responses: Array<ApprovalResponse | number> = [];
  h.provider.onRun(async (req: StartRunRequest, gw) => {
    for (const [i, ask] of asks.entries()) {
      const res = await gw.post("approvals", {
        type: "approval_request",
        approvalId: `apr-${i}`,
        ...(ask.kind ? { kind: ask.kind } : {}),
        action: ask.action,
        riskLevel: "L2",
        toolUseId: `toolu_${i}`,
      });
      responses.push(res.status === 200 ? ((await res.json()) as ApprovalResponse) : res.status);
    }
    await gw.post("ended", {
      type: "run_ended",
      runId: req.runId,
      outcome: "completed",
      summary: summary("done"),
      usage: [],
    });
  });
  const posted = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${thread.id}/messages`, {
    body: "clean up and publish",
  });
  const first = posted.json.runs[0] as RunRecord;
  const { ctx } = h.app.deskmates;
  await waitFor(() => responses.length === asks.length, 3000, "asks answered");
  return { ctx, workspace, thread, run: first, responses };
}

const notices = (h: Harness, threadId: string) =>
  h.app.deskmates.ctx.messages
    .list(threadId as never)
    .filter((m) => m.authorKind === "system" && m.body.startsWith("Approval needed"));

describe("approve_all (ADR-0002 amendment 6, D4)", () => {
  it("allows a routine action, a deletion and a permission expansion at once, as mode:approve_all", async () => {
    const s = await run([
      { action: bash("git push origin main") },
      { action: bash("rm -rf build") },
      { action: bash("sudo chmod 777 /work") },
      { action: { toolName: "NewSdkTool", input: {}, unclassified: true } },
    ]);
    expect(s.responses).toEqual(
      [0, 1, 2, 3].map((i) => ({
        type: "approval_response",
        approvalId: `apr-${i}`,
        decision: "allow",
      })),
    );
    for (const i of [0, 1, 2, 3]) {
      const approval = s.ctx.approvals.mustGet(`apr-${i}` as ApprovalId);
      expect(approval).toMatchObject({ decision: "allow_once", decidedBy: APPROVAL_MODE_ACTOR });
      const audit = s.ctx.audit.list({ targetId: `apr-${i}` });
      expect(audit.map((row) => [row.action, row.actor])).toEqual([
        ["approval.decide", APPROVAL_MODE_ACTOR],
      ]);
    }
    // Nothing reached the thread, nobody was woken and no reviewer ran.
    expect(notices(h, s.thread.id)).toHaveLength(0);
    expect(s.ctx.runs.list({}).filter((r) => r.config.runType === APPROVAL_REVIEW)).toEqual([]);
    const allowed = s.ctx.events
      .list(s.run.id)
      .filter((e) => e.kind === "approval" && e.payload.phase === "mode_allowed");
    expect(allowed.map((e) => e.payload.approvalId)).toEqual(["apr-0", "apr-1", "apr-2", "apr-3"]);
    await waitFor(() => s.ctx.runs.mustGet(s.run.id).status === "succeeded", 2000, "end");
  });

  it("an egress ask adds the host through the allowlist writer and is recorded as allow_always", async () => {
    const s = await run([{ kind: "egress", action: egress("docs.databricks.com") }]);
    expect(s.responses[0]).toMatchObject({ decision: "allow" });
    const approval = s.ctx.approvals.mustGet("apr-0" as ApprovalId);
    expect(approval).toMatchObject({
      kind: "egress",
      decision: "allow_always",
      decidedBy: APPROVAL_MODE_ACTOR,
    });
    expect(s.ctx.workspaces.mustGet(s.workspace.id).egressAllowlist).toEqual([
      "*.example.test",
      "docs.databricks.com",
    ]);
    // The allowlist change is audited under the mode, as any allowlist change is.
    const change = s.ctx.audit
      .list({ workspaceId: s.workspace.id })
      .find((row) => row.action === "egress.allowlist_set");
    expect(change?.actor).toBe(APPROVAL_MODE_ACTOR);
    // No tool rule is stored for an egress ask.
    expect(s.ctx.rules.list(approval.botId)).toEqual([]);
  });

  it("an egress ask for a host that is not a public hostname goes to humans (D5)", async () => {
    const s = await run([{ kind: "egress", action: egress("10.0.0.5") }]);
    // Nobody online: the ask defers rather than being allowed.
    expect(s.responses[0]).toMatchObject({ decision: "defer" });
    expect(s.ctx.approvals.mustGet("apr-0" as ApprovalId).decision).toBeUndefined();
    expect(s.ctx.workspaces.mustGet(s.workspace.id).egressAllowlist).toEqual(["*.example.test"]);
    expect(notices(h, s.thread.id)).toHaveLength(1);
  });

  it("a stored deny rule still answers before the mode", async () => {
    const s = await run([{ action: bash("git push origin main") }], (botId) => {
      h.app.deskmates.ctx.rules.create({
        botId: botId as never,
        matcher: { toolName: "Bash", argumentPattern: "git push*" },
        decision: "deny",
        createdBy: "human:ops",
      });
    });
    expect(s.responses[0]).toMatchObject({ decision: "deny" });
    expect(s.ctx.approvals.mustGet("apr-0" as ApprovalId).decidedBy).toMatch(/^rule:/);
  });

  it("still scrubs a secret-shaped value out of the stored action (D5)", async () => {
    const s = await run([
      { action: bash("curl -H 'Authorization: Bearer sk-live-abcdef0123456789' https://x.test") },
    ]);
    expect(s.responses[0]).toMatchObject({ decision: "allow" });
    const stored = JSON.stringify(s.ctx.approvals.mustGet("apr-0" as ApprovalId).action);
    expect(stored).not.toContain("sk-live-abcdef0123456789");
  });
});
