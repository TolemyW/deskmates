// T1: the Gateway's startup timeline marks (ADR-0037 decisions 1 to 3, 5) through the real
// scheduler and the fake sandbox provider: a cold then warm sandbox, a new then resumed SDK
// session, a sidecar that dies without `run_ended`, a sandbox that cannot be prepared, and the
// operator route that derives the timeline from the whole ledger.

import {
  DeskmatesError,
  type RunEvent,
  type RunId,
  type RunTimeline,
  type StartRunRequest,
  type Thread,
} from "@deskmates/contracts";
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

const summary = (reply: string) => ({
  done: "ok",
  filesChanged: [],
  sitesVisited: [],
  pendingApprovals: [],
  memorySuggestions: [],
  reply,
});

async function wake(thread: Thread, body: string): Promise<RunRecord> {
  const m = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${thread.id}/messages`, {
    body,
  });
  const run = m.json.runs[0];
  if (!run) throw new Error("no run created");
  return run;
}

async function settled(id: RunId): Promise<RunRecord> {
  const { ctx } = h.app.deskmates;
  await waitFor(
    () => ["succeeded", "silent", "failed"].includes(ctx.runs.mustGet(id).status),
    3000,
    "run end",
  );
  // `attempt_closed` is written when the exec resolves, right after `run_ended`.
  await waitFor(() => marks(id).some((m) => m.mark === "attempt_closed"), 3000, "attempt closed");
  return ctx.runs.mustGet(id);
}

function marks(id: RunId): Record<string, unknown>[] {
  return h.app.deskmates.ctx.events
    .list(id)
    .filter((e: RunEvent) => e.kind === "log" && e.payload.source === "run_timeline")
    .map((e) => ({ ...e.payload, attempt: e.attempt }));
}

describe("Gateway timeline marks", () => {
  it("marks a cold first attempt and a warm, resumed second run", async () => {
    const { thread } = await h.seed();
    h.provider.onRun(async (req: StartRunRequest, gw) => {
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        sdkSessionId: "sess-1",
        summary: summary("Hello"),
        usage: [],
      });
    });
    const first = await settled((await wake(thread, "hi")).id);
    expect(first.status).toBe("succeeded");
    const m1 = marks(first.id);
    expect(m1.map((m) => m.mark)).toEqual([
      "attempt_started",
      "sandbox_ready",
      "sidecar_spawned",
      "run_ended",
      "attempt_closed",
    ]);
    expect(m1[0]).toMatchObject({ start: "fresh", session: "new", trigger: "thread_message" });
    expect(m1[1]).toMatchObject({ sandbox: "created" });
    expect(m1[3]).toMatchObject({ outcome: "completed", replyPosted: true });
    expect(m1[4]).toMatchObject({ spawned: true, exitCode: 0 });
    for (const m of m1) expect(m).toMatchObject({ source: "run_timeline", version: 1, attempt: 1 });

    const second = await settled((await wake(thread, "again")).id);
    const m2 = marks(second.id);
    expect(m2[0]).toMatchObject({ start: "fresh", session: "resumed" });
    expect(m2[1]).toMatchObject({ sandbox: "cached" });

    const timeline = await h.api<RunTimeline>("GET", `/api/runs/${second.id}/timeline`);
    expect(timeline.status).toBe(200);
    const [attempt] = timeline.json.attempts;
    expect(attempt).toMatchObject({ start: "fresh", session: "resumed", sandbox: "cached" });
    const visible = attempt?.stages.find((s) => s.stage === "first_visible_text");
    expect(visible?.observed).toBe(true);
    // The fake SDK is not in this path: the sidecar's own stages are honestly absent.
    const init = attempt?.stages.find((s) => s.stage === "sdk_init");
    expect(init).toMatchObject({ observed: false, missing: "not_observed", sinceStartMs: null });
    expect(timeline.json.e2eMs).not.toBeNull();
  });

  it("closes an attempt whose sidecar exited without run_ended", async () => {
    const { thread } = await h.seed();
    h.provider.onRun(async () => ({ exitCode: 1, stdout: "", stderr: "crashed" }));
    const run = await settled((await wake(thread, "hi")).id);
    expect(run.status).toBe("failed");
    const m = marks(run.id);
    expect(m.map((x) => x.mark)).toEqual([
      "attempt_started",
      "sandbox_ready",
      "sidecar_spawned",
      "attempt_closed",
    ]);
    expect(m[3]).toMatchObject({ spawned: true, exitCode: 1 });
  });

  it("records a sandbox that was prepared on its second try", async () => {
    const { thread } = await h.seed();
    h.provider.onRun(async (req: StartRunRequest, gw) => {
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary(""),
        usage: [],
      });
    });
    h.provider.createErrors.push(new DeskmatesError("sandbox_unavailable", "not healthy"));
    const retried = await settled((await wake(thread, "hi")).id);
    expect(marks(retried.id)[1]).toMatchObject({ sandbox: "created", sandboxRetried: true });
    expect(marks(retried.id)[3]).toMatchObject({ replyPosted: false });
  });

  it("closes an attempt whose sandbox could not be prepared", async () => {
    const { thread } = await h.seed();
    for (let i = 0; i < 2; i++)
      h.provider.createErrors.push(new DeskmatesError("sandbox_unavailable", `not healthy ${i}`));
    const failed = await settled((await wake(thread, "hi")).id);
    expect(failed.status).toBe("failed");
    expect(marks(failed.id).map((x) => x.mark)).toEqual(["attempt_started", "attempt_closed"]);
    expect(marks(failed.id)[1]).toMatchObject({ spawned: false, error: "sandbox_error" });
  });

  it("answers 404 for an unknown run", async () => {
    const res = await h.api("GET", "/api/runs/run_missing/timeline");
    expect(res.status).toBe(404);
  });
});
