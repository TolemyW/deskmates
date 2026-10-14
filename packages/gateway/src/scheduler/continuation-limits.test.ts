// T1: the per-attempt turn cap and the continuation limit as workspace settings, frozen when a
// run first starts (ADR-0016 amendment 2, decisions 14 to 17). Fake sidecar, no model.

import type {
  ApprovalId,
  Run,
  RunEnded,
  RunId,
  StartRunRequest,
  ThreadMessage,
} from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";

let h: Harness;
let requests: StartRunRequest[];
/** Each attempt ends with the next outcome; past the list it completes. */
let outcomes: RunEnded["outcome"][];

function ended(req: StartRunRequest, outcome: RunEnded["outcome"]): RunEnded {
  return {
    type: "run_ended",
    runId: req.runId,
    outcome,
    sdkSessionId: "sess-1",
    usage: [],
    ...(outcome === "turns_exhausted"
      ? { handoffPath: "/work/handoffs/h.md" }
      : {
          summary: {
            done: "done",
            filesChanged: [],
            sitesVisited: [],
            pendingApprovals: [],
            memorySuggestions: [],
            reply: "done",
          },
        }),
  } as RunEnded;
}

beforeEach(async () => {
  requests = [];
  outcomes = [];
  h = await startHarness();
  h.provider.onRun(async (req, gw) => {
    requests.push(req);
    await gw.post("ended", ended(req, outcomes.shift() ?? "completed"));
    return undefined;
  });
});

afterEach(async () => {
  await h.close();
});

const ctx = () => h.app.deskmates.ctx;
const run = (id: RunId) => ctx().runs.mustGet(id);

async function post(threadId: string): Promise<RunId> {
  const posted = await h.api<{ message: ThreadMessage; runs: Run[] }>(
    "POST",
    `/api/threads/${threadId}/messages`,
    { body: "work" },
  );
  const id = posted.json.runs[0]?.id;
  if (!id) throw new Error("no run");
  return id;
}

async function parked(id: RunId, attempt: number): Promise<ApprovalId> {
  await waitFor(
    () => run(id).status === "waiting_continuation" && run(id).attempt === attempt,
    5000,
    `park after attempt ${attempt}`,
  );
  return run(id).resumePayload?.approvalId as ApprovalId;
}

async function continueRun(id: RunId, approvalId: ApprovalId): Promise<void> {
  ctx().broker.decide(approvalId, "allow_once", "human:alice");
  h.app.deskmates.scheduler.kick();
}

describe("frozen run limits (ADR-0016 amendment 2)", () => {
  it("sends the Gateway's maxTurns with source gateway when the workspace stores nothing", async () => {
    const { thread } = await h.seed();
    const id = await post(thread.id);
    await waitFor(() => run(id).status === "succeeded", 5000, "run");
    expect(requests[0]?.maxTurns).toBe(50);
    expect(run(id).config).toMatchObject({
      maxTurns: 50,
      continuationLimit: 2,
      continuationWindowHours: 24,
      limitSources: { maxTurns: "gateway", continuationLimit: "default" },
      limitsVersion: 1,
    });
  });

  it("freezes the workspace values: a change while parked does not reach the resumed attempt", async () => {
    const { workspace, thread } = await h.seed();
    ctx().limits.set(
      workspace.id,
      { maxTurns: 12, continuationLimit: 1, continuationWindowHours: 2 },
      "user:admin",
    );
    outcomes = ["turns_exhausted", "turns_exhausted"];
    const id = await post(thread.id);
    const approvalId = await parked(id, 1);
    expect(requests[0]?.maxTurns).toBe(12);
    expect(run(id).config.limitSources).toMatchObject({ maxTurns: "workspace" });

    // Decision 17: the request names the cap, its source and what is left; the window is frozen.
    const request = ctx()
      .messages.list(thread.id, 0)
      .find((m) => m.body.includes("-turn attempt limit"));
    expect(request?.body).toContain("reached the 12-turn attempt limit (workspace)");
    expect(request?.body).toContain("1 of 1 continuations left");
    const event = ctx()
      .events.list(id)
      .find((e) => e.payload.phase === "continuation_requested");
    expect(event?.payload).toMatchObject({ continuationLimit: 1, continuationWindowHours: 2 });
    const expires = Date.parse(String(event?.payload.expiresAt));
    expect(expires - Date.now()).toBeGreaterThan(1.9 * 3600_000);
    expect(expires - Date.now()).toBeLessThan(2.1 * 3600_000);

    ctx().limits.set(workspace.id, { maxTurns: 30, continuationLimit: 5 }, "user:admin");
    await continueRun(id, approvalId);
    await waitFor(() => run(id).status === "failed", 5000, "second exhaustion fails");
    expect(requests[1]?.attempt).toBe(2);
    expect(requests[1]?.maxTurns).toBe(12);
    expect(run(id).error).toBe("turn budget exhausted after 1 continuations");
  });

  it("a continuation limit of 0 fails the first exhaustion without asking", async () => {
    const { workspace, thread } = await h.seed();
    ctx().limits.set(workspace.id, { continuationLimit: 0 }, "user:admin");
    outcomes = ["turns_exhausted"];
    const id = await post(thread.id);
    await waitFor(() => run(id).status === "failed", 5000, "failed");
    expect(
      ctx()
        .approvals.list()
        .filter((a) => a.runId === id),
    ).toEqual([]);
    expect(run(id).resumePayload).toBeUndefined();
  });

  it("off sends no turn cap and asks on every exhaustion, never failing for the count", async () => {
    const { workspace, thread } = await h.seed();
    ctx().budget.setLimits(workspace.id, { weeklyLimitUsd: 20 }, "user:admin");
    ctx().limits.set(workspace.id, { maxTurns: "off", continuationLimit: "off" }, "user:admin");
    outcomes = ["turns_exhausted", "turns_exhausted", "turns_exhausted"];
    const id = await post(thread.id);
    expect(await parked(id, 1)).toBeDefined();
    expect(requests[0]?.maxTurns).toBeNull();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const approvalId = await parked(id, attempt);
      await continueRun(id, approvalId);
    }
    await waitFor(() => run(id).status === "succeeded", 5000, "fourth attempt succeeds");
    expect(requests.map((r) => r.maxTurns)).toEqual([null, null, null, null]);
    expect(run(id).config.continuationCount).toBe(3);
  });
});
