// T1 (ADR-0048 amendment 1, A3): the shared-screen lease. Two bots' focus-free calls hold shared
// leases at once; an exclusive call waits for them, then excludes every other desktop call and
// every browser acquire; a waiting exclusive call is served before later shared calls and before
// later exclusive ones; a human hold refuses everything and renewals report it; a lease expires
// when its proxy stops renewing; a run's leases go when it ends.

import {
  DESKTOP_SCREEN_BUSY_MESSAGE,
  type DesktopLeaseMode,
  type DesktopLockResponse,
  HUMAN_HOLDS_BROWSER_MESSAGE,
  type RunId,
  type WorkspaceId,
} from "@deskmates/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { DESKTOP_LEASE_TTL_MS, DesktopInputLocks } from "./desktop-input-lock.js";

const WS = "ws_a" as WorkspaceId;
const OTHER_WS = "ws_b" as WorkspaceId;
const NOVA = "run_nova" as RunId;
const VEGA = "run_vega" as RunId;
const LYRA = "run_lyra" as RunId;

let now: number;
let human: boolean;
let epoch: number;
let locks: DesktopInputLocks;

beforeEach(() => {
  now = 1_000_000;
  human = false;
  epoch = 7;
  locks = new DesktopInputLocks({
    humanHolds: () => human,
    epoch: () => epoch,
    now: () => now,
  });
});

const acquire = (
  runId: RunId,
  callId: string,
  mode: DesktopLeaseMode,
  ws = WS,
): DesktopLockResponse =>
  locks.handle(ws, { type: "desktop_lock", runId, op: "acquire", callId, mode });
const renew = (runId: RunId, callId: string) =>
  locks.handle(WS, { type: "desktop_lock", runId, op: "renew", callId });
const release = (runId: RunId, callId: string) =>
  locks.handle(WS, { type: "desktop_lock", runId, op: "release", callId });

describe("desktop shared-screen lease (ADR-0048 amendment 1, A3)", () => {
  it("lets two bots' focus-free calls overlap", () => {
    expect(acquire(NOVA, "1", "shared")).toMatchObject({ granted: true, epoch: 7 });
    expect(acquire(VEGA, "1", "shared")).toMatchObject({ granted: true });
    expect(locks.list(WS).map((l) => l.mode)).toEqual(["shared", "shared"]);
    expect(locks.exclusiveHeld(WS)).toBe(false);
  });

  it("makes a raw-input call wait for the shared ones, then exclude every other call", () => {
    acquire(NOVA, "1", "shared");
    expect(acquire(VEGA, "1", "exclusive")).toMatchObject({
      granted: false,
      contended: true,
      waitMessage: DESKTOP_SCREEN_BUSY_MESSAGE,
    });
    // The waiting exclusive call blocks a new shared call, so shared calls cannot starve it.
    expect(acquire(LYRA, "1", "shared")).toMatchObject({ granted: false, contended: true });
    release(NOVA, "1");
    expect(acquire(VEGA, "1", "exclusive")).toMatchObject({ granted: true });
    expect(locks.exclusiveHeld(WS)).toBe(true);
    expect(acquire(NOVA, "2", "shared")).toMatchObject({ granted: false, contended: true });
    expect(acquire(NOVA, "3", "exclusive")).toMatchObject({ granted: false, contended: true });
    // The same run's second call is excluded too: one pointer, one focus.
    expect(acquire(VEGA, "2", "shared")).toMatchObject({ granted: false });
    // Another workspace has its own screen.
    expect(acquire(LYRA, "1", "exclusive", OTHER_WS)).toMatchObject({ granted: true });
    release(VEGA, "1");
    expect(locks.exclusiveHeld(WS)).toBe(false);
  });

  it("serves waiting exclusive calls in arrival order", () => {
    acquire(NOVA, "1", "shared");
    acquire(VEGA, "1", "exclusive");
    acquire(LYRA, "1", "exclusive");
    release(NOVA, "1");
    expect(acquire(LYRA, "1", "exclusive")).toMatchObject({ granted: false });
    expect(acquire(VEGA, "1", "exclusive")).toMatchObject({ granted: true });
    release(VEGA, "1");
    expect(acquire(LYRA, "1", "exclusive")).toMatchObject({ granted: true });
  });

  it("refuses every lease and renewal while a human holds the workspace", () => {
    acquire(NOVA, "1", "shared");
    human = true;
    epoch = 8;
    for (const response of [
      acquire(VEGA, "1", "shared"),
      acquire(LYRA, "1", "exclusive"),
      renew(NOVA, "1"),
      locks.handle(WS, { type: "desktop_lock", runId: NOVA, op: "probe" }),
    ])
      expect(response).toMatchObject({
        granted: false,
        waitMessage: HUMAN_HOLDS_BROWSER_MESSAGE,
        epoch: 8,
      });
    human = false;
    // After the handback the old call's renewal is granted with the new epoch, which the proxy
    // compares and treats as a change of hands.
    expect(renew(NOVA, "1")).toMatchObject({ granted: true, epoch: 8 });
    expect(locks.handle(WS, { type: "desktop_lock", runId: NOVA, op: "probe" }).granted).toBe(true);
  });

  it("expires a lease its proxy stopped renewing, and drops a run's leases when it ends", () => {
    acquire(NOVA, "1", "exclusive");
    now += DESKTOP_LEASE_TTL_MS - 1;
    expect(renew(NOVA, "1").granted).toBe(true);
    now += DESKTOP_LEASE_TTL_MS + 1;
    expect(renew(NOVA, "1").granted).toBe(false);
    expect(acquire(VEGA, "1", "exclusive").granted).toBe(true);
    locks.releaseForRun(VEGA);
    expect(locks.list(WS)).toEqual([]);
  });
});
