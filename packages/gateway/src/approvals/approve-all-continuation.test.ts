// T1, ADR-0002 amendment 6 D6: turn-exhaustion continuations under `approve_all`. Within the
// workspace continuation limit the mode continues at once; past it the reviewer decides, and its
// `deny` stops the run. Under `manual` past the limit the run fails as before. Fake sidecar, no
// model: the review job's reply is scripted.

import {
  APPROVAL_MODE_ACTOR,
  type ApprovalId,
  type ApprovalMode,
  type Run,
  type RunEnded,
  type RunId,
  type StartRunRequest,
  type ThreadMessage,
} from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";

let h: Harness;
let outcomes: RunEnded["outcome"][];
let verdicts: string[];
let packages: string[];

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
  outcomes = [];
  verdicts = [];
  packages = [];
  h = await startHarness();
  h.provider.onRun(async (req, gw) => {
    if (req.modelJob?.kind === "approval_review") {
      packages.push(req.modelJob.reviewPackage);
      const reply = verdicts.shift() ?? "";
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: {
          done: "verdict",
          filesChanged: [],
          sitesVisited: [],
          pendingApprovals: [],
          memorySuggestions: [],
          reply,
        },
        usage: [],
      });
      return undefined;
    }
    await gw.post("ended", ended(req, outcomes.shift() ?? "completed"));
    return undefined;
  });
});

afterEach(async () => {
  await h.close();
});

const ctx = () => h.app.deskmates.ctx;
const run = (id: RunId) => ctx().runs.mustGet(id);

async function start(mode: ApprovalMode): Promise<{ id: RunId; threadId: string }> {
  const { workspace, thread } = await h.seed({ approvalMode: mode });
  ctx().limits.set(workspace.id, { continuationLimit: 1 }, "user:admin");
  const posted = await h.api<{ message: ThreadMessage; runs: Run[] }>(
    "POST",
    `/api/threads/${thread.id}/messages`,
    { body: "migrate the whole repository" },
  );
  const id = posted.json.runs[0]?.id;
  if (!id) throw new Error("no run");
  return { id, threadId: thread.id };
}

const continuations = (id: RunId) =>
  ctx()
    .approvals.list({})
    .filter((a) => a.runId === id && a.kind === "continuation")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

describe("approve_all continuations (ADR-0002 amendment 6, D6)", () => {
  it("continues within the limit as the mode, and past it on the reviewer's allow", async () => {
    outcomes = ["turns_exhausted", "turns_exhausted"];
    verdicts = ['{"verdict":"allow_once","reason":"the migration is progressing"}'];
    const { id } = await start("approve_all");
    await waitFor(() => run(id).status === "succeeded", 8000, "continued twice and finished");
    expect(run(id).attempt).toBe(3);
    const [first, second] = continuations(id);
    expect(first).toMatchObject({ decision: "allow_once", decidedBy: APPROVAL_MODE_ACTOR });
    expect(second?.decision).toBe("allow_once");
    expect(second?.decidedBy).toMatch(/^reviewer:/);
    // The reviewer saw the instruction, the count, the limit and the handoff; nothing else ran it.
    expect(packages).toHaveLength(1);
    expect(JSON.parse(packages[0] as string)).toMatchObject({
      instructionSource: "human_message",
      instruction: "migrate the whole repository",
      continuation: {
        continuationCount: 1,
        continuationLimit: 1,
        handoffPath: "/work/handoffs/h.md",
      },
      action: { toolName: "__run_continuation__" },
    });
  });

  it("stops the run past the limit when the reviewer denies", async () => {
    outcomes = ["turns_exhausted", "turns_exhausted"];
    verdicts = ['{"verdict":"deny","reason":"it is repeating the same step"}'];
    const { id } = await start("approve_all");
    await waitFor(() => run(id).status === "stopped", 8000, "stopped by the reviewer");
    expect(run(id).attempt).toBe(2);
    expect(continuations(id)[1]?.decision).toBe("deny");
  });

  it("an escalated review is posted for people, who may still continue", async () => {
    outcomes = ["turns_exhausted", "turns_exhausted"];
    verdicts = ['{"verdict":"escalate","reason":"cannot tell"}'];
    const { id, threadId } = await start("approve_all");
    await waitFor(
      () =>
        ctx()
          .messages.list(threadId as never)
          .some((m) => m.body.startsWith("Approval needed")),
      8000,
      "escalated",
    );
    const pending = continuations(id)[1];
    expect(pending?.decision).toBeUndefined();
    ctx().broker.decide(pending?.id as ApprovalId, "allow_once", "human:alice");
    h.app.deskmates.scheduler.kick();
    await waitFor(() => run(id).status === "succeeded", 8000, "continued by a person");
  });

  it("under manual the run fails past the limit as before", async () => {
    outcomes = ["turns_exhausted", "turns_exhausted"];
    const { id } = await start("manual");
    await waitFor(() => run(id).status === "waiting_continuation", 5000, "first ask");
    const [first] = continuations(id);
    expect(first?.decision).toBeUndefined();
    ctx().broker.decide(first?.id as ApprovalId, "allow_once", "human:alice");
    h.app.deskmates.scheduler.kick();
    await waitFor(() => run(id).status === "failed", 5000, "failed past the limit");
    expect(packages).toEqual([]);
  });
});
