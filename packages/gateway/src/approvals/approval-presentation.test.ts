import type { ApprovalId, RunId } from "@deskmates/contracts";
import { expect, it } from "vitest";
import type { RunRecord } from "../ledger/runs.js";
import { startHarness, waitFor } from "../test-support/harness.js";

it("queues one isolated default-model summary, accounts usage and leaves the approval and transcript intact", async () => {
  const h = await startHarness();
  try {
    const { thread } = await h.seed();
    const approvalId = "approval_summary_test" as ApprovalId;
    const action = {
      toolName: "Bash",
      input: { command: `echo ${"long ".repeat(200)}` },
      argumentSummary: "echo long message",
    };
    h.provider.onRun(async (request, gw) => {
      if (request.presentationSummary) {
        expect(request.model).toBe("test-model-default");
        expect(request.maxTurns).toBe(1);
        expect(request.threadId).toBeUndefined();
        expect(request.sdkSessionId).toBeUndefined();
        await gw.post("ended", {
          type: "run_ended",
          runId: request.runId,
          outcome: "completed",
          summary: {
            done: "summary",
            reply: "Writes a long message to standard output.",
            filesChanged: [],
            sitesVisited: [],
            pendingApprovals: [],
            memorySuggestions: [],
          },
          usage: [
            {
              model: request.model,
              inputTokens: 20,
              outputTokens: 10,
              cacheReadTokens: 3,
              cacheCreateTokens: 2,
            },
          ],
        });
        return;
      }
      const body = {
        type: "approval_request",
        approvalId,
        action,
        riskLevel: "L2",
        toolUseId: "tool_1",
      };
      await gw.post("approvals", body);
      await gw.post("approvals", body);
      await gw.post("ended", {
        type: "run_ended",
        runId: request.runId,
        outcome: "deferred",
        pendingApprovalId: approvalId,
        pendingToolUseId: "tool_1",
        sdkSessionId: "session_test",
        usage: [],
      });
    });
    await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${thread.id}/messages`, {
      body: "Show a message",
    });
    const ctx = h.app.deskmates.ctx;
    await waitFor(() => !!ctx.approvals.get(approvalId)?.displaySummary, 3000, "presentation");
    const approval = ctx.approvals.mustGet(approvalId);
    expect(approval.action).toEqual(action);
    expect(approval.decision).toBeUndefined();
    expect(approval.instruction).toBe("Show a message");
    const summaryRun = ctx.runs.mustGet(approval.displaySummary?.runId as RunId);
    expect(summaryRun.config.runType).toBe("approval_presentation");
    expect(summaryRun.triggerKind).toBe("model_job");
    expect(ctx.usage.list(summaryRun.id)[0]).toMatchObject({
      inputTokens: 20,
      outputTokens: 10,
      cacheReadTokens: 3,
      cacheCreateTokens: 2,
    });
    expect(h.provider.execCalls.filter((call) => call.request.presentationSummary)).toHaveLength(1);
    const messages = await h.api<{ messages: { body: string }[] }>(
      "GET",
      `/api/threads/${thread.id}/messages`,
    );
    expect(
      messages.json.messages.some((message) => message.body === approval.displaySummary?.text),
    ).toBe(false);
  } finally {
    await h.close();
  }
});
