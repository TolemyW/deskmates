// T0 and T1, issue #9: stall detection. The monitor alone on a fake clock (what counts as
// progress, when a run stalls, how it comes back), then through the Gateway: a run whose sidecar
// keeps only its heartbeat goes `stalled`, is not cancelled, and is `running` again on its next
// event; a stalled run may still end.

import {
  type RunEvent,
  type RunId,
  type RunStatus,
  type StartRunRequest,
  canTransition,
} from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { AppendEventInput } from "../ledger/events.js";
import type { RunRecord } from "../ledger/runs.js";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";
import { RunStallMonitor, isProgressEvent } from "./run-stall.js";

const heartbeat = { kind: "log", payload: { source: "resource_observation" } } as const;

/** Runs as a status map that follows the contracts state machine. */
function fakeRuns(initial: Record<string, RunStatus>) {
  const statuses = new Map<string, RunStatus>(Object.entries(initial));
  const record = (id: string): RunRecord => ({ id, status: statuses.get(id) }) as RunRecord;
  return {
    statuses,
    get: (id: RunId) => (statuses.has(id) ? record(id) : undefined),
    listWithStatus: (wanted: readonly RunStatus[]) =>
      [...statuses].filter(([, s]) => wanted.includes(s)).map(([id]) => record(id)),
    transition: (id: RunId, to: RunStatus) => {
      const from = statuses.get(id);
      if (!from || !canTransition(from, to)) throw new Error(`${from} -> ${to}`);
      statuses.set(id, to);
      return record(id);
    },
  };
}

function monitor(initial: Record<string, RunStatus>, stallSeconds = 60) {
  let nowMs = 0;
  const runs = fakeRuns(initial);
  const appended: AppendEventInput[] = [];
  const published: RunStatus[] = [];
  const stalls = new RunStallMonitor(
    {
      runs,
      appendEvent: (input) => appended.push(input),
      publish: (run) => published.push(run.status),
    },
    stallSeconds,
    () => nowMs,
  );
  return {
    stalls,
    runs,
    appended,
    published,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

const event = (runId: string, e: Pick<RunEvent, "kind" | "payload">) => ({
  runId: runId as RunId,
  ...e,
});

describe("progress events (issue #9)", () => {
  it("counts everything but the heartbeat and the stall records themselves", () => {
    expect(isProgressEvent({ kind: "tool_call", payload: {} })).toBe(true);
    expect(isProgressEvent({ kind: "log", payload: { source: "phase_timing" } })).toBe(true);
    expect(isProgressEvent({ kind: "log", payload: { source: "assistant" } })).toBe(true);
    expect(isProgressEvent(heartbeat)).toBe(false);
    expect(isProgressEvent({ kind: "log", payload: { source: "stall" } })).toBe(false);
  });
});

describe("RunStallMonitor (issue #9)", () => {
  it("stalls a running run quiet for the interval, records it once, and never ends it", () => {
    const m = monitor({ r1: "running" });
    expect(m.stalls.sweep()).toEqual([]); // first sight starts the clock
    m.advance(30_000);
    m.stalls.observe(event("r1", heartbeat));
    m.advance(29_999);
    expect(m.stalls.sweep()).toEqual([]);
    m.advance(1);
    expect(m.stalls.sweep().map((r) => r.id)).toEqual(["r1"]);
    expect(m.runs.statuses.get("r1")).toBe("stalled");
    expect(m.published).toEqual(["stalled"]);
    expect(m.appended).toEqual([
      {
        runId: "r1",
        kind: "log",
        payload: { source: "stall", op: "stalled", idleMs: 60_000, stallSeconds: 60 },
      },
    ]);
    m.advance(600_000);
    expect(m.stalls.sweep()).toEqual([]);
    expect(m.runs.statuses.get("r1")).toBe("stalled");
    expect(m.appended).toHaveLength(1);
  });

  it("returns a stalled run to running on its next progress event, not on a heartbeat", () => {
    const m = monitor({ r1: "running" });
    m.stalls.sweep();
    m.advance(60_000);
    m.stalls.sweep();
    m.advance(5_000);
    m.stalls.observe(event("r1", heartbeat));
    expect(m.runs.statuses.get("r1")).toBe("stalled");
    m.stalls.observe(event("r1", { kind: "tool_result", payload: {} }));
    expect(m.runs.statuses.get("r1")).toBe("running");
    expect(m.published).toEqual(["stalled", "running"]);
    expect(m.appended.at(-1)?.payload).toEqual({
      source: "stall",
      op: "resumed",
      idleMs: 65_000,
      stallSeconds: 60,
    });
    // Its clock restarted with that event.
    m.advance(59_000);
    expect(m.stalls.sweep()).toEqual([]);
  });

  it("leaves parked, queued and live-approval runs alone and restarts the clock after them", () => {
    const m = monitor({ q: "queued", a: "waiting_approval_live", p: "waiting_approval" });
    m.stalls.sweep();
    m.advance(3_600_000);
    expect(m.stalls.sweep()).toEqual([]);
    // An approval event during the wait is forgotten once the sweep sees the run is not running.
    m.stalls.observe(event("a", { kind: "approval", payload: {} }));
    m.advance(3_600_000);
    m.stalls.sweep();
    // Back from a long live approval wait: its clock starts at the next sweep, not before.
    m.runs.statuses.set("a", "running");
    expect(m.stalls.sweep()).toEqual([]);
    m.advance(59_000);
    expect(m.stalls.sweep()).toEqual([]);
    m.runs.statuses.set("p", "running");
    m.advance(1_000);
    expect(m.stalls.sweep().map((r) => r.id)).toEqual(["a"]);
    expect(m.runs.statuses.get("p")).toBe("running");
    expect(m.runs.statuses.get("q")).toBe("queued");
  });

  it("does not revive a stalled run that has ended since", () => {
    const m = monitor({ r1: "running" });
    m.stalls.sweep();
    m.advance(60_000);
    m.stalls.sweep();
    m.runs.statuses.set("r1", "failed");
    expect(m.stalls.touch("r1" as RunId)).toBeUndefined();
    expect(m.runs.statuses.get("r1")).toBe("failed");
  });

  it("does nothing when the interval is 0", () => {
    const m = monitor({ r1: "running" }, 0);
    m.stalls.sweep();
    m.advance(86_400_000);
    expect(m.stalls.sweep()).toEqual([]);
    expect(m.runs.statuses.get("r1")).toBe("running");
  });
});

describe("stall detection through the Gateway (issue #9)", () => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  it("marks a heartbeat-only run stalled without cancelling it, and revives it on its next event", async () => {
    h = await startHarness({ runStallSeconds: 1 });
    const { ctx, scheduler } = h.app.deskmates;
    const { thread } = await h.seed();
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let posted = false;
    h.provider.onRun(async (req: StartRunRequest, gw) => {
      const post = (seq: number, kind: string, payload: Record<string, unknown>) =>
        gw.post("events", { type: "event", attempt: 1, seq, kind, payload });
      // The model request opened but never answered; only the heartbeat keeps coming.
      await post(1, "log", { source: "resource_observation", version: 1 });
      posted = true;
      await released;
      await post(2, "log", { source: "resource_observation", version: 1 });
      await post(3, "tool_call", { toolUseId: "t1", toolName: "Bash", input: {} });
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: {
          done: "ok",
          filesChanged: [],
          sitesVisited: [],
          pendingApprovals: [],
          memorySuggestions: [],
          reply: "done",
        },
        usage: [],
      });
    });
    const posted0 = await h.api<{ runs: RunRecord[] }>(
      "POST",
      `/api/threads/${thread.id}/messages`,
      { body: "hi" },
    );
    const id = posted0.json.runs[0]?.id as RunId;
    await waitFor(() => posted, 3000, "heartbeat posted");
    scheduler.sweepStalls();
    expect(ctx.runs.mustGet(id).status).toBe("running");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    scheduler.sweepStalls();
    expect(ctx.runs.mustGet(id).status).toBe("stalled");
    // Listed with the live runs, holding its lane, never terminal.
    expect(ctx.runs.listActive().map((r) => r.id)).toContain(id);
    const runs = await h.api<{ runs: RunRecord[] }>("GET", `/api/runs?threadId=${thread.id}`);
    expect(runs.json.runs.find((r) => r.id === id)?.status).toBe("stalled");

    release();
    await waitFor(() => ctx.runs.mustGet(id).status === "succeeded", 3000, "run end");
    const stallLogs = ctx.events
      .list(id)
      .filter((e) => e.kind === "log" && e.payload.source === "stall")
      .map((e) => e.payload.op);
    expect(stallLogs).toEqual(["stalled", "resumed"]);
    // The heartbeat after the stall did not revive it; the tool call did.
    const kinds = ctx.events.list(id).map((e) => `${e.kind}:${e.payload.source ?? ""}`);
    const resumedAt = kinds.indexOf("log:stall", kinds.indexOf("log:stall") + 1);
    expect(kinds[resumedAt - 1]).toBe("tool_call:");
  });
});
