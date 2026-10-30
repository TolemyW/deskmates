// T1: an exec that rejects (issue #61 M5). The sandbox-error path fails only the attempt's own
// live run, as the success path does; a late rejection of an older attempt leaves the run that
// attempt parked alone. Nothing on the failure path may become an unhandled rejection, which
// would exit the Gateway.

import type { ExecRequest, ExecResult, SandboxHandle } from "@deskmates/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RunRecord } from "../ledger/runs.js";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";

let h: Harness;
let logged: string[];

beforeEach(async () => {
  h = await startHarness();
  logged = [];
  const scheduler = h.app.deskmates.scheduler as unknown as {
    log: (msg: string, data?: Record<string, unknown>) => void;
  };
  scheduler.log = (msg) => logged.push(msg);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await h.close();
});

/** The provider's exec runs the script, then rejects as a dropped Docker connection would. */
function rejectAfterExec(): void {
  const exec = h.provider.exec.bind(h.provider);
  h.provider.exec = async (handle: SandboxHandle, req: ExecRequest): Promise<ExecResult> => {
    await exec(handle, req);
    throw new Error("connection reset");
  };
}

async function wake(body: string): Promise<RunRecord> {
  const { thread } = await h.seed();
  const posted = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${thread.id}/messages`, {
    body,
  });
  const run = posted.json.runs[0];
  if (!run) throw new Error("no run created");
  return run;
}

it("a late rejection of the attempt that parked a run leaves the parked run alone", async () => {
  const { ctx, scheduler } = h.app.deskmates;
  h.provider.onRun(async (req, gw) => {
    await gw.post("approvals", {
      type: "approval_request",
      approvalId: "apr-late",
      action: { toolName: "Bash", input: { command: "git push" }, argumentSummary: "git push" },
      riskLevel: "L2",
      toolUseId: "toolu_late",
    });
    await gw.post("ended", {
      type: "run_ended",
      runId: req.runId,
      outcome: "deferred",
      sdkSessionId: "sess-late",
      usage: [],
      pendingApprovalId: "apr-late",
      pendingToolUseId: "toolu_late",
    });
  });
  rejectAfterExec();
  const run = await wake("push it");
  await waitFor(() => h.provider.execCalls.length === 1, 3000, "exec");
  await scheduler.drain();
  expect(ctx.runs.mustGet(run.id).status).toBe("waiting_approval");
  expect(ctx.approvals.mustGet("apr-late" as never).decision).toBeUndefined();
});

it("a sandbox error is still a failed run when the attempt is the live one", async () => {
  const { ctx, scheduler } = h.app.deskmates;
  h.provider.execErrors.push(new Error("container went away"));
  const run = await wake("work");
  await waitFor(() => ctx.runs.mustGet(run.id).status === "failed", 3000, "failed");
  await scheduler.drain();
  expect(ctx.runs.mustGet(run.id).error).toContain("sandbox error");
});

it("a throw while recording a sandbox error is logged, not an unhandled rejection", async () => {
  const { ctx, scheduler, lifecycle } = h.app.deskmates;
  h.provider.execErrors.push(new Error("container went away"));
  vi.spyOn(lifecycle, "fail").mockImplementationOnce(() => {
    throw new Error("SQLITE_BUSY: database is locked");
  });
  const run = await wake("work");
  await waitFor(() => logged.includes("sandbox error could not be recorded"), 3000, "logged");
  await scheduler.drain();
  expect(ctx.runs.mustGet(run.id).status).not.toBe("queued");
});

it("whatever still escapes an attempt is logged, never an unhandled rejection", async () => {
  const { scheduler, lifecycle } = h.app.deskmates;
  h.provider.execErrors.push(new Error("container went away"));
  vi.spyOn(lifecycle, "fail").mockImplementationOnce(() => {
    throw new Error("SQLITE_BUSY: database is locked");
  });
  // Even the failure path's own log line throws: `launch` still catches what escapes `execute`.
  const scheduled = scheduler as unknown as {
    log: (msg: string, data?: Record<string, unknown>) => void;
  };
  scheduled.log = (msg) => {
    if (msg === "sandbox error could not be recorded") throw new Error("log sink closed");
    logged.push(msg);
  };
  await wake("work");
  await waitFor(() => logged.includes("run attempt ended with an error"), 3000, "logged");
  await scheduler.drain();
});
