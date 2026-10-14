// `GET /api/capacity?workspaceId=` (issue #16): how much a workspace can take right now, for an
// external client deciding how much to submit. Computed on read from the runs and browser-lock
// tables and the sandbox; nothing here is stored.

import type { BotId, RunId, WorkspaceId } from "./ids.js";
import type { RunLane } from "./run.js";

/** One lane of one bot (design v0.3 §3.4: one run per lane at a time). */
export interface LaneCapacity {
  /**
   * No run holds the lane (`running`, `waiting_approval_live`). A queued run on a free lane starts
   * on the next scheduling pass unless its tenant is suspended or its workspace is over its disk
   * quota.
   */
  free: boolean;
  /** The run holding the lane, when one does. */
  activeRunId?: RunId;
  /** Runs waiting to start on this lane. */
  queued: number;
  /** Parked runs (approval, browser, continuation): they hold no lane but resume on this one. */
  parked: number;
}

export interface BotCapacity {
  botId: BotId;
  name: string;
  lanes: Record<RunLane, LaneCapacity>;
}

/**
 * Who holds the workspace's one browser. A human takeover is exclusive for the whole workspace;
 * runs hold leases per tab, so several may hold it at once.
 */
export type BrowserLockHolder = { kind: "human" } | { kind: "run"; runIds: RunId[] };

export interface WorkspaceCapacity {
  workspaceId: WorkspaceId;
  /**
   * Whether the workspace's sandbox is up. Read the way the screen status reads it: an existing
   * sandbox is attached, a missing one is reported, never created.
   */
  containerRunning: boolean;
  /** `null` while nobody holds the browser. */
  browserLock: BrowserLockHolder | null;
  /**
   * Sidecar processes executing in the workspace now. Their number is not capped (ADR-0022
   * amendment 5); the container's CPU and memory limits bound them together.
   */
  sidecars: { active: number };
  bots: BotCapacity[];
}

export interface CapacityResponse {
  capacity: WorkspaceCapacity;
}
