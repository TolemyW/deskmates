// What the Gateway reports about its own process to an operator, e.g. a release script.

import type { RunId } from "./ids.js";

/**
 * `GET /api/runtime`: the drain signal an upgrade polls before it stops the Gateway. A run counts
 * as active while its sidecar process is executing (`running`, `waiting_approval_live`); a queued
 * run has no process yet and a parked run (`waiting_approval`, `waiting_browser`) has none any
 * more, and both survive a restart intact.
 */
export interface RuntimeStatus {
  activeRuns: number;
  activeRunIds: RunId[];
}
