import { afterEach, expect, it } from "vitest";
import type { RunRecord } from "../ledger/runs.js";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
});

it.each([false, true])(
  "preserves a parked denial reason, including in a paused thread (%s)",
  async (paused) => {
    h = await startHarness();
    const harness = h;
    const { thread } = await harness.seed();
    harness.provider.onRun(async (request, gw) => {
      if (request.trigger.kind === "thread_message") {
        await gw.post("approvals", {
          type: "approval_request",
          runId: request.runId,
          approvalId: "apr_reason",
          toolUseId: "call_reason",
          riskLevel: "L2",
          action: {
            toolName: "Bash",
            input: { command: "git push origin main" },
            argumentPattern: "git push*",
          },
        });
        await gw.post("ended", {
          type: "run_ended",
          runId: request.runId,
          outcome: "deferred",
          sdkSessionId: "session-reason",
          pendingApprovalId: "apr_reason",
          pendingToolUseId: "call_reason",
          usage: [],
        });
      } else {
        await gw.post("ended", {
          type: "run_ended",
          runId: request.runId,
          outcome: "completed",
          usage: [],
          summary: {
            done: "stopped the refused action",
            filesChanged: [],
            sitesVisited: [],
            pendingApprovals: [],
            memorySuggestions: [],
            reply: "understood",
          },
        });
      }
    });
    const response = await harness.api<{ runs: RunRecord[] }>(
      "POST",
      `/api/threads/${thread.id}/messages`,
      { body: "prepare a push" },
    );
    const run = response.json.runs[0] as RunRecord;
    await waitFor(
      () => harness.app.deskmates.ctx.runs.mustGet(run.id).status === "waiting_approval",
      3000,
      "parked",
    );
    if (paused)
      expect(
        (await harness.api("PATCH", `/api/threads/${thread.id}`, { status: "paused" })).status,
      ).toBe(200);
    expect(
      (
        await harness.api("POST", "/api/approvals/apr_reason/decide", {
          decision: "deny",
          reason: "Keep the changes local until review.",
        })
      ).status,
    ).toBe(200);
    await waitFor(() => harness.provider.execCalls.length === 2, 3000, "approval resumed");
    expect(harness.provider.execCalls[1]?.request.trigger).toMatchObject({
      kind: "approval",
      decision: "deny",
      reason: "Denied by human: Keep the changes local until review.",
    });
    // ADR-0005 decision 27: an approval resumes existing work; it creates no new wake.
    if (paused) expect(harness.app.deskmates.ctx.threads.mustGet(thread.id).status).toBe("paused");
  },
);
