// T1 (ADR-0021 amendment 2): a run is offered `task_deliver`, with the tasks it may deliver, only
// when an open task is linked to its thread or to the run itself.
import type { RunEnded, RunId } from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunRecord } from "../ledger/runs.js";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
  h.provider.onRun(async (req, gw) => {
    const ended: RunEnded = {
      type: "run_ended",
      runId: req.runId as RunId,
      outcome: "completed",
      summary: {
        done: "answered",
        filesChanged: [],
        sitesVisited: [],
        pendingApprovals: [],
        memorySuggestions: [],
        reply: "ok",
      },
      usage: [],
    };
    await gw.post("ended", ended);
  });
});
afterEach(async () => {
  await h.close();
});

async function runOnce(threadId: string) {
  const posted = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${threadId}/messages`, {
    body: "go",
  });
  const run = posted.json.runs[0] as RunRecord;
  await waitFor(() => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded", 3000, "run");
  return h.provider.execCalls.at(-1)?.request;
}

describe("deliverable tasks on the start request", () => {
  it("offers nothing when no open task is linked", async () => {
    const { workspace, thread } = await h.seed();
    h.app.deskmates.ctx.tasks.create(workspace.id, { title: "Unlinked" });
    const request = await runOnce(thread.id);
    expect(request?.tools).not.toContain("task_deliver");
    expect(request?.deliverableTasks).toBeUndefined();
  });

  it("offers task_deliver with the linked tasks and their schemas", async () => {
    const { workspace, thread } = await h.seed();
    const schema = { type: "object", required: ["rows"] };
    const task = h.app.deskmates.ctx.tasks.create(workspace.id, {
      title: "Count rows",
      threadIds: [thread.id],
      outputSchema: schema,
    });
    const request = await runOnce(thread.id);
    expect(request?.tools).toContain("task_deliver");
    expect(request?.deliverableTasks).toEqual([
      { id: task.id, title: "Count rows", outputSchema: schema, scopeVersion: 1 },
    ]);
  });
});
