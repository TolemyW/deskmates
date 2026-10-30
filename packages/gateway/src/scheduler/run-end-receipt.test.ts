// T1: transport completion is not the Gateway's validation result for a model job.
import type { RunId, SoulProposal, StartRunRequest } from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

const summary = (reply: string) => ({
  done: "Model response",
  reply,
  filesChanged: [],
  sitesVisited: [],
  pendingApprovals: [],
  memorySuggestions: [],
});

async function closed(runId: RunId) {
  const { ctx } = h.app.deskmates;
  await waitFor(
    () => ctx.events.list(runId).some((event) => event.payload.mark === "attempt_closed"),
    3000,
    "attempt closed",
  );
  const receipt = ctx.events
    .list(runId)
    .find((event) => event.payload.source === "run_timeline" && event.payload.mark === "run_ended");
  expect(receipt).toBeDefined();
  return { receipt: receipt?.payload, run: ctx.runs.mustGet(runId) };
}

describe("run end receipts", () => {
  it.each([
    { reply: "", status: "failed", proposalStatus: "failed" },
    { reply: "# Reviewer\n\nReview changes.\n", status: "succeeded", proposalStatus: "ready" },
  ])(
    "keeps the sidecar outcome and records $status after model-job validation",
    async ({ reply, status, proposalStatus }) => {
      const { bot } = await h.seed();
      h.provider.onRun(async (request: StartRunRequest, gw) => {
        expect(request.modelJob?.kind).toBe("soul_proposal");
        await gw.post("ended", {
          type: "run_ended",
          runId: request.runId,
          outcome: "completed",
          summary: summary(reply),
          usage: [],
        });
      });
      const response = await h.api<{ proposal: SoulProposal }>(
        "POST",
        `/api/bots/${bot.id}/soul-proposals`,
        { instruction: "Draft a reviewer role" },
      );
      expect(response.status).toBe(202);
      const { run, receipt } = await closed(response.json.proposal.runId as RunId);
      expect(run.status).toBe(status);
      expect(receipt).toMatchObject({
        outcome: "completed",
        runStatus: status,
        replyPosted: false,
      });
      const proposal = await h.api<{ proposal: SoulProposal }>(
        "GET",
        `/api/bots/${bot.id}/soul-proposals/${response.json.proposal.id}`,
      );
      expect(proposal.json.proposal.status).toBe(proposalStatus);
      expect(h.app.deskmates.ctx.bots.canonicalSoul(bot.id)?.body ?? "").toBe("");
    },
  );

  it("records the committed chat result without changing final delivery", async () => {
    const { thread } = await h.seed();
    h.provider.onRun(async (request: StartRunRequest, gw) => {
      await gw.post("ended", {
        type: "run_ended",
        runId: request.runId,
        outcome: "completed",
        summary: summary("Done"),
        usage: [],
      });
    });
    const response = await h.api<{ runs: Array<{ id: RunId }> }>(
      "POST",
      `/api/threads/${thread.id}/messages`,
      { body: "Say done" },
    );
    const runId = response.json.runs[0]?.id;
    if (!runId) throw new Error("No run created");
    const { run, receipt } = await closed(runId);
    expect(run.status).toBe("succeeded");
    expect(receipt).toMatchObject({
      outcome: "completed",
      runStatus: "succeeded",
      replyPosted: true,
    });
    expect(
      h.app.deskmates.ctx.messages.postedByRun(runId).filter((message) => message.body === "Done"),
    ).toHaveLength(1);
  });
});
