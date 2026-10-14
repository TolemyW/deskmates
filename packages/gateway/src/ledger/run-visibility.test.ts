// T1 (issue #70): a run's visibility flags. `silent` keeps its ADR-0005 meaning, an empty final
// reply; the run API reports beside it whether the run posted, decided an approval or delivered
// a task, derived from what the Gateway wrote, so no historical row changes meaning.

import type { RunVisibility } from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";
import { runVisibility } from "./run-visibility.js";
import type { RunRecord } from "./runs.js";

type RunWithVisibility = RunRecord & { visibility: RunVisibility };

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

function endWith(reply: string): Parameters<Harness["provider"]["onRun"]>[0] {
  return async (req, gw) => {
    await gw.post("ended", {
      type: "run_ended",
      runId: req.runId,
      outcome: "completed",
      summary: {
        done: "done",
        filesChanged: [],
        sitesVisited: [],
        pendingApprovals: [],
        memorySuggestions: [],
        reply,
      },
      usage: [],
    });
  };
}

async function settledRun(threadId: string, body: string): Promise<RunWithVisibility> {
  const posted = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${threadId}/messages`, {
    body,
  });
  const runId = posted.json.runs[0]?.id as RunRecord["id"];
  const runs = h.app.deskmates.ctx.runs;
  await waitFor(
    () => ["succeeded", "silent", "failed"].includes(runs.mustGet(runId).status),
    3000,
    "run end",
  );
  const detail = await h.api<{ run: RunWithVisibility }>("GET", `/api/runs/${runId}`);
  return detail.json.run;
}

const NOTHING: RunVisibility = {
  finalReply: false,
  postedToThread: false,
  decidedApproval: false,
  deliveredTask: false,
  visibleOutcome: false,
};

describe("run visibility on the run API", () => {
  it("reports nothing visible for a silent run that did nothing", async () => {
    const { thread } = await h.seed();
    h.provider.onRun(endWith(""));
    const run = await settledRun(thread.id, "fyi");
    expect(run.status).toBe("silent");
    expect(run.visibility).toEqual(NOTHING);
  });

  it("keeps a run that answered through thread_post silent and reports the post", async () => {
    const { thread } = await h.seed();
    h.provider.onRun(async (req, gw) => {
      await gw.post("messages", {
        type: "post_message",
        runId: req.runId,
        tool: "thread_post",
        body: "answered mid-run",
      });
      await endWith("")(req, gw);
    });
    const run = await settledRun(thread.id, "answer this");
    expect(run.status).toBe("silent");
    expect(run.visibility).toEqual({ ...NOTHING, postedToThread: true, visibleOutcome: true });
    // The list route reports the same flags as the detail route.
    const listed = await h.api<{ runs: RunWithVisibility[] }>(
      "GET",
      `/api/runs?threadId=${thread.id}`,
    );
    expect(listed.json.runs.find((r) => r.id === run.id)?.visibility).toEqual(run.visibility);
  });

  it("reports the final reply of a succeeded run", async () => {
    const { thread } = await h.seed();
    h.provider.onRun(endWith("here it is"));
    const run = await settledRun(thread.id, "answer this");
    expect(run.status).toBe("succeeded");
    expect(run.visibility).toEqual({ ...NOTHING, finalReply: true, visibleOutcome: true });
  });
});

describe("runVisibility", () => {
  it("reads only the runs it is given and ignores look-alikes the Gateway did not write", async () => {
    const { bot, thread } = await h.seed();
    const ctx = h.app.deskmates.ctx;
    const create = () =>
      ctx.runs.create({
        botId: bot.id,
        threadId: thread.id,
        lane: "interactive",
        triggerKind: "thread_message",
        triggerRef: "test",
      });
    const decider = create();
    const deliverer = create();
    const idle = create();
    ctx.events.append({
      runId: decider.id,
      kind: "approval",
      payload: { phase: "decided_by_tool", approvalId: "apr_1", decision: "deny" },
    });
    ctx.events.append({
      runId: deliverer.id,
      kind: "log",
      payload: { tool: "task_deliver", taskId: "task_1", summary: "done" },
    });
    ctx.events.append({
      runId: idle.id,
      kind: "tool_call",
      payload: { tool: "thread_post", messageId: "msg_1" },
    });
    const map = runVisibility(ctx.db, [decider, idle]);
    expect([...map.keys()].sort()).toEqual([decider.id, idle.id].sort());
    expect(map.get(decider.id)).toEqual({
      ...NOTHING,
      decidedApproval: true,
      visibleOutcome: true,
    });
    expect(map.get(idle.id)).toEqual(NOTHING);
    expect(runVisibility(ctx.db, [deliverer]).get(deliverer.id)).toEqual({
      ...NOTHING,
      deliveredTask: true,
      visibleOutcome: true,
    });
    expect(runVisibility(ctx.db, []).size).toBe(0);
  });
});
