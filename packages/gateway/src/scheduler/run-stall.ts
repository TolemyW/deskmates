// Stall detection (issue #9). A `running` run that has produced no progress event for the stall
// interval is marked `stalled`; its next progress event, or any other call its sidecar makes to
// the Gateway, returns it to `running`. Nothing is killed: the wall clock stays the only kill, and
// the lane, token and browser lock are untouched, because a stalled run is still a live process.
//
// The clock is the Gateway's own, kept in memory per run. A Gateway restart fails every live run
// (`Scheduler.reconcile`), stalled ones included, so nothing it forgets would still be running.

import {
  RUN_STALL_LOG_SOURCE,
  type RunEvent,
  type RunId,
  type RunStallLogPayload,
} from "@deskmates/contracts";
import type { AppendEventInput } from "../ledger/events.js";
import type { RunRecord, RunStore } from "../ledger/runs.js";

/** How often the scheduler looks for stalled runs; a stall shows within this of its interval. */
export const STALL_SWEEP_INTERVAL_MS = 5_000;

/**
 * Whether an event shows the run moving. The 10 s `resource_observation` only shows that the
 * sidecar process is alive, so a run waiting on an upstream that never answers still stalls; the
 * Gateway's own stall records are not progress either, or marking a run would revive it.
 */
export function isProgressEvent(event: Pick<RunEvent, "kind" | "payload">): boolean {
  if (event.kind !== "log") return true;
  const source = event.payload.source;
  return source !== "resource_observation" && source !== RUN_STALL_LOG_SOURCE;
}

export interface RunStallDeps {
  runs: Pick<RunStore, "get" | "listWithStatus" | "transition">;
  appendEvent: (input: AppendEventInput) => unknown;
  /** Publishes the run's new status (the `run_status` frame). */
  publish: (run: RunRecord) => void;
}

export class RunStallMonitor {
  /** When each executing run last showed progress, by the Gateway's clock. */
  private readonly lastProgressMs = new Map<RunId, number>();
  /** Runs this monitor marked `stalled`; only it sets the status, so only these can be revived. */
  private readonly stalled = new Set<RunId>();

  constructor(
    private readonly deps: RunStallDeps,
    private readonly stallSeconds: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Every stored event passes here; a progress event restarts the run's quiet clock. */
  observe(event: Pick<RunEvent, "runId" | "kind" | "payload">): void {
    if (!isProgressEvent(event)) return;
    this.touch(event.runId);
  }

  /**
   * The run showed progress: a ledger event, or its sidecar reached another internal route. A
   * `stalled` run goes back to `running`. Returns the revived run, if it was stalled.
   */
  touch(runId: RunId): RunRecord | undefined {
    const now = this.now();
    const last = this.lastProgressMs.get(runId);
    this.lastProgressMs.set(runId, now);
    if (!this.stalled.delete(runId)) return undefined;
    // Ended, cancelled or parked since it was marked: nothing to revive.
    if (this.deps.runs.get(runId)?.status !== "stalled") return undefined;
    const revived = this.deps.runs.transition(runId, "running");
    this.record(runId, "resumed", last === undefined ? 0 : now - last);
    this.deps.publish(revived);
    return revived;
  }

  /**
   * Marks every `running` run quiet for the interval as `stalled` and returns them. A run first
   * seen running starts its clock at that sweep, so one that has just started, resumed or come
   * back from a live approval wait is never stalled at once. Runs no longer executing are
   * forgotten.
   */
  sweep(): RunRecord[] {
    if (this.stallSeconds <= 0) return [];
    const now = this.now();
    const limitMs = this.stallSeconds * 1000;
    const marked: RunRecord[] = [];
    const seen = new Set<RunId>();
    for (const run of this.deps.runs.listWithStatus(["running", "stalled"])) {
      seen.add(run.id);
      const last = this.lastProgressMs.get(run.id);
      if (last === undefined) {
        this.lastProgressMs.set(run.id, now);
        continue;
      }
      if (run.status === "stalled") {
        this.stalled.add(run.id);
        continue;
      }
      if (now - last < limitMs) continue;
      const stalled = this.deps.runs.transition(run.id, "stalled");
      this.stalled.add(run.id);
      this.record(run.id, "stalled", now - last);
      this.deps.publish(stalled);
      marked.push(stalled);
    }
    for (const id of [...this.lastProgressMs.keys()]) {
      if (!seen.has(id)) this.lastProgressMs.delete(id);
    }
    for (const id of [...this.stalled]) if (!seen.has(id)) this.stalled.delete(id);
    return marked;
  }

  private record(runId: RunId, op: RunStallLogPayload["op"], idleMs: number): void {
    const payload: RunStallLogPayload = {
      source: RUN_STALL_LOG_SOURCE,
      op,
      idleMs: Math.round(idleMs),
      stallSeconds: this.stallSeconds,
    };
    this.deps.appendEvent({ runId, kind: "log", payload: { ...payload } });
  }
}
