// The shared-screen lease of desktop calls (ADR-0048 amendment 1, A3, Proposed). X11 on the
// workspace's Xvfb has one pointer and one keyboard focus, so raw input from two bots interleaves;
// accessibility calls and captures need neither. Each desktop call holds a lease for as long as it
// runs: `shared` leases of any number of runs coexist; an `exclusive` lease is granted only when no
// other lease is held, blocks every other desktop lease and every browser lock acquire while it is
// held, and, while it waits, blocks new shared leases so they cannot starve it; waiting exclusive
// requests are served in arrival order. A human hold refuses everything (ADR-0008). The leases live
// in the Gateway's memory: they last one call, expire when their proxy stops renewing them, and a
// Gateway restart reconciles every live run anyway (ADR-0029). A soft distinction between bots,
// not a boundary: a bot's own shell can still send input outside it (ADR-0004).

import {
  DESKTOP_SCREEN_BUSY_MESSAGE,
  type DesktopLockRequest,
  type DesktopLockResponse,
  HUMAN_HOLDS_BROWSER_MESSAGE,
  type RunId,
  type WorkspaceId,
} from "@deskmates/contracts";
import type { GatewayContext } from "../context.js";
import type { GatewayDb } from "../db/open.js";

/** A granted lease lasts this long past its last renewal; the proxy renews every two seconds. */
export const DESKTOP_LEASE_TTL_MS = 15_000;
/** A waiting exclusive request keeps its place this long past its last retry. */
export const DESKTOP_WAIT_TTL_MS = 5_000;

type LeaseMode = "exclusive" | "shared" | "waiting";

interface Lease {
  runId: RunId;
  callId: string;
  mode: LeaseMode;
  /** Arrival order of exclusive requests. */
  ticket: number;
  expiresAt: number;
}

export interface DesktopInputLocksDeps {
  humanHolds(workspaceId: WorkspaceId): boolean;
  epoch(workspaceId: WorkspaceId): number;
  now?: () => number;
}

export class DesktopInputLocks {
  private readonly leases = new Map<WorkspaceId, Map<string, Lease>>();
  private ticket = 0;

  constructor(private readonly deps: DesktopInputLocksDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private workspace(workspaceId: WorkspaceId): Map<string, Lease> {
    let leases = this.leases.get(workspaceId);
    if (!leases) {
      leases = new Map();
      this.leases.set(workspaceId, leases);
    }
    const now = this.now();
    for (const [key, lease] of leases) if (lease.expiresAt <= now) leases.delete(key);
    return leases;
  }

  private result(
    workspaceId: WorkspaceId,
    runId: RunId,
    granted: boolean,
    extra: Partial<DesktopLockResponse> = {},
  ): DesktopLockResponse {
    return {
      type: "desktop_lock_result",
      runId,
      granted,
      epoch: this.deps.epoch(workspaceId),
      ...extra,
    };
  }

  handle(workspaceId: WorkspaceId, req: DesktopLockRequest): DesktopLockResponse {
    const leases = this.workspace(workspaceId);
    const key = `${req.runId}\u0000${req.callId ?? ""}`;
    if (req.op === "release") {
      leases.delete(key);
      return this.result(workspaceId, req.runId, true);
    }
    if (this.deps.humanHolds(workspaceId)) {
      if (leases.get(key)?.mode === "waiting") leases.delete(key);
      return this.result(workspaceId, req.runId, false, {
        waitMessage: HUMAN_HOLDS_BROWSER_MESSAGE,
      });
    }
    if (req.op === "probe") return this.result(workspaceId, req.runId, true);
    const own = leases.get(key);
    const now = this.now();
    if (req.op === "renew") {
      if (!own || own.mode === "waiting") return this.result(workspaceId, req.runId, false);
      own.expiresAt = now + DESKTOP_LEASE_TTL_MS;
      return this.result(workspaceId, req.runId, true);
    }
    const others = [...leases.entries()].filter(([k]) => k !== key).map(([, lease]) => lease);
    if (req.mode === "shared") {
      if (others.some((lease) => lease.mode !== "shared"))
        return this.result(workspaceId, req.runId, false, {
          contended: true,
          waitMessage: DESKTOP_SCREEN_BUSY_MESSAGE,
        });
      leases.set(key, {
        runId: req.runId,
        callId: req.callId ?? "",
        mode: "shared",
        ticket: 0,
        expiresAt: now + DESKTOP_LEASE_TTL_MS,
      });
      return this.result(workspaceId, req.runId, true);
    }
    const ticket = own?.mode === "waiting" ? own.ticket : ++this.ticket;
    const blocked = others.some((lease) => lease.mode !== "waiting" || lease.ticket < ticket);
    if (blocked) {
      leases.set(key, {
        runId: req.runId,
        callId: req.callId ?? "",
        mode: "waiting",
        ticket,
        expiresAt: now + DESKTOP_WAIT_TTL_MS,
      });
      return this.result(workspaceId, req.runId, false, {
        contended: true,
        waitMessage: DESKTOP_SCREEN_BUSY_MESSAGE,
      });
    }
    leases.set(key, {
      runId: req.runId,
      callId: req.callId ?? "",
      mode: "exclusive",
      ticket,
      expiresAt: now + DESKTOP_LEASE_TTL_MS,
    });
    return this.result(workspaceId, req.runId, true);
  }

  /** Whether a granted exclusive lease holds the workspace's screen (browser acquires wait). */
  exclusiveHeld(workspaceId: WorkspaceId): boolean {
    for (const lease of this.workspace(workspaceId).values())
      if (lease.mode === "exclusive") return true;
    return false;
  }

  /** Every lease of a run that ended; its proxy is gone. */
  releaseForRun(runId: RunId): void {
    for (const leases of this.leases.values())
      for (const [key, lease] of leases) if (lease.runId === runId) leases.delete(key);
  }

  /** The leases of a workspace now, for tests and diagnostics. */
  list(workspaceId: WorkspaceId): { runId: RunId; callId: string; mode: LeaseMode }[] {
    return [...this.workspace(workspaceId).values()].map(({ runId, callId, mode }) => ({
      runId,
      callId,
      mode,
    }));
  }
}

const stores = new WeakMap<GatewayDb, DesktopInputLocks>();

/**
 * The lease store for a Gateway context, built on first use rather than held on the context,
 * whose field list is a former hotspot (scripts/hotspot-budgets.test.mjs).
 */
export function desktopInputLocks(ctx: Pick<GatewayContext, "db" | "locks">): DesktopInputLocks {
  let store = stores.get(ctx.db);
  if (!store) {
    store = new DesktopInputLocks({
      humanHolds: (workspaceId) => ctx.locks.humanHolds(workspaceId),
      epoch: (workspaceId) => ctx.locks.epoch(workspaceId),
    });
    stores.set(ctx.db, store);
  }
  return store;
}
