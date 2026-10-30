// What the Gateway reports about its own process to an operator, e.g. a release script.

import type { AddressPoolHeadroom } from "./host-resources.js";
import type { RunId } from "./ids.js";

/**
 * `GET /api/runtime`: the drain signal an upgrade polls before it stops the Gateway. A run counts
 * as active while its sidecar process is executing (`running`, `stalled`,
 * `waiting_approval_live`); a queued run has no process yet and a parked run
 * (`waiting_approval`, `waiting_browser`, `waiting_platform`) has none any more, and both survive
 * a restart intact.
 */
export interface RuntimeStatus {
  activeRuns: number;
  activeRunIds: RunId[];
  /**
   * ADR-0029 decision 1: the Gateway is draining, so the scheduler starts and resumes nothing
   * while triggers are still accepted and recorded. A property of the running process: a new
   * Gateway starts out of drain.
   */
  draining: boolean;
  /** When this drain began; absent when not draining. */
  drainStartedAt?: string;
  /** Runs this process's drain parked at a safe point (`waiting_platform`, reason `drain`). */
  drainParkedRunIds: RunId[];
  /** ADR-0029 decision 6: the restart breaker and the platform-parked runs it holds. */
  restartBreaker: RestartBreakerStatus;
  /**
   * The daemon's address-pool headroom from the Gateway's last host-resource check, at start or
   * on request (ADR-0006 amendment 5 decision 14); absent before the first check completes.
   */
  addressPools?: AddressPoolHeadroom;
}

export interface RestartBreakerStatus {
  /** More than `limit` Gateway starts within `windowMinutes`; parked runs wait for an operator. */
  tripped: boolean;
  startsInWindow: number;
  limit: number;
  windowMinutes: number;
  /** `waiting_platform` runs an operator has to resume (`POST /api/runtime/platform-resume`). */
  heldRunIds: RunId[];
}

/** `POST /api/runtime/platform-resume`: the held runs the operator let go. */
export interface PlatformResumeResponse {
  resumedRunIds: RunId[];
}
