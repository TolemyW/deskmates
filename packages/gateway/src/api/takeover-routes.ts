// Human takeover of the shared browser (design v0.3 §3.3, ADR-0004 decision 6). The lock is
// workspace-wide, never per bot: while a human holds it, the browser tools of every run in that
// workspace return the wait message (`BrowserLockStore.handle`), and the takeover is recorded on
// every run that has a live sidecar so the transcript says why it stalled.

import {
  type BrowserLock,
  DeskmatesError,
  type WorkspaceId,
  decidedByHuman,
} from "@deskmates/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { liveKeyOf } from "../auth/principal.js";
import type { GatewayContext } from "../context.js";
import { requestActorId } from "./actor.js";
import { requestRole, requestTenant, roleAtLeast } from "./route-policy.js";
import { asRecord, optionalString } from "./validate.js";

/** The human holder of the workspace browser, if there is one. Run holders are not shown here. */
export function humanBrowserLock(
  ctx: GatewayContext,
  workspaceId: WorkspaceId,
): BrowserLock | null {
  return ctx.locks.list(workspaceId).find((l) => l.holderKind === "human") ?? null;
}

/**
 * Whether the workspace's container publishes the shared takeover screen. Reads the sandbox with
 * `peek`, which never creates a container: opening a workspace page must not start a machine.
 * The address itself never leaves the Gateway; the screen proxy reaches it (ADR-0022
 * amendment 1, C7).
 */
export async function workspaceHasTakeoverScreen(
  ctx: GatewayContext,
  workspaceId: WorkspaceId,
): Promise<boolean> {
  const handle = await ctx.sandboxes.peek(workspaceId);
  return Boolean(handle?.novncAddress);
}

/**
 * Who holds a workspace's human lease (ADR-0022 DESK-01/02), as recorded with the lock:
 * `session:<id>` for a signed-in person, `service:<id>` for a service principal (ADR-0022
 * amendment 2), `operator` for the operator credential.
 */
export function holderOf(request: FastifyRequest): string {
  const principal = request.principal;
  if (principal?.kind === "user") return `session:${principal.sessionId}`;
  if (principal?.kind === "service") return `service:${principal.servicePrincipalId}`;
  return "operator";
}

const SESSION_HOLDER = "session:";
const SERVICE_HOLDER = "service:";

export function registerTakeoverRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  const author = (request: FastifyRequest): string =>
    decidedByHuman(requestActorId(request, request.body));
  // Live-connection registrations of leases taken through this process, so a logout here ends
  // the lease at once. The sweep below covers everything else (restart, CLI, other process).
  const registrations = new Map<string, () => void>();

  /** Free the human lease, once, and say so to the workspace's runs and streams. */
  const releaseLease = (workspaceId: WorkspaceId, by: string): void => {
    registrations.get(workspaceId)?.();
    registrations.delete(workspaceId);
    const held = ctx.locks.humanHolds(workspaceId);
    ctx.locks.humanRelease(workspaceId);
    if (held) {
      mark(workspaceId, "handed_back", by);
      ctx.bus.publish({ type: "workspace_lock", workspaceId, browserLock: null });
    }
  };

  /** Whether this request is the person (session) holding the workspace's lease. */
  const isHolder = (request: FastifyRequest, workspaceId: WorkspaceId): boolean =>
    ctx.locks.humanHolder(workspaceId) === holderOf(request);

  /**
   * End every lease whose holder's session is gone or no longer a member of the workspace's
   * tenant. Runs periodically, so revocation reaches a lease after a restart or from the CLI.
   */
  const sweep = (): number => {
    let released = 0;
    for (const { workspaceId, holder } of ctx.locks.humanLeases()) {
      const tenantId = ctx.ownership.tenantOf("workspace", workspaceId);
      if (holder.startsWith(SERVICE_HOLDER)) {
        const id = holder.slice(SERVICE_HOLDER.length);
        if (tenantId !== undefined && ctx.auth.servicePrincipalActive(id, tenantId)) continue;
        releaseLease(workspaceId, "system:session_ended");
        released += 1;
        continue;
      }
      if (!holder.startsWith(SESSION_HOLDER)) continue;
      const sessionId = holder.slice(SESSION_HOLDER.length);
      if (tenantId !== undefined && ctx.auth.sessionStillAuthorized(sessionId, tenantId)) continue;
      releaseLease(workspaceId, "system:session_ended");
      released += 1;
    }
    return released;
  };
  const sweepMs = ctx.auth.config.liveSweepMs;
  if (sweepMs > 0) {
    const timer = setInterval(sweep, sweepMs);
    timer.unref();
    app.addHook("onClose", async () => clearInterval(timer));
  }

  /** One `takeover` event per run whose tools are affected right now. */
  const mark = (workspaceId: WorkspaceId, phase: "taken" | "handed_back", by: string): void => {
    for (const run of ctx.runs.listLiveInWorkspace(workspaceId)) {
      ctx.events.append({ runId: run.id, kind: "takeover", payload: { phase, by } });
    }
  };

  app.post<{ Params: { id: string } }>("/api/workspaces/:id/takeover", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const workspaceId = request.params.id as WorkspaceId;
    ctx.workspaces.mustGet(workspaceId);
    const by = author(request);
    // A second person cannot borrow a lease someone else holds; they wait for the hand back.
    const me = holderOf(request);
    const current = ctx.locks.humanHolder(workspaceId);
    if (typeof current === "string" && current !== me)
      throw new DeskmatesError("browser_held_by_human", "another person holds this browser", {
        workspaceId,
      });
    const previousOrigins = ctx.originQueue
      .list(workspaceId)
      .filter((entry) => entry.status === "held");
    const lock = ctx.db.transaction(() => {
      const taken = ctx.locks.humanTake(workspaceId, undefined, me);
      ctx.originQueue.preempt(workspaceId);
      return taken;
    })();
    for (const entry of previousOrigins)
      ctx.events.append({
        runId: entry.runId,
        kind: "log",
        payload: {
          source: "browser_origin",
          op: "preempted",
          origin: entry.origin,
          reason: "human",
        },
      });
    mark(workspaceId, "taken", by);
    ctx.bus.publish({ type: "workspace_lock", workspaceId, browserLock: lock });
    if (current !== me) {
      registrations.get(workspaceId)?.();
      registrations.delete(workspaceId);
      const liveKey = liveKeyOf(request.principal);
      // Logout, revocation or losing this tenant's membership (or, for a service principal,
      // disabling or rotating it) ends the lease at once in this process; the sweep catches
      // whatever happens elsewhere.
      if (liveKey !== undefined)
        registrations.set(
          workspaceId,
          ctx.auth.live.register(
            liveKey,
            () => {
              if (ctx.locks.humanHolder(workspaceId) === me)
                releaseLease(workspaceId, "system:session_ended");
            },
            requestTenant(request),
          ),
        );
    }
    // The lease only: the screen is opened through the proxy (`.../takeover/open-screen` in
    // screen-routes.ts), never by a direct noVNC address and password (ADR-0022 amendment 1).
    return { lock };
  });

  app.post<{ Params: { id: string } }>("/api/workspaces/:id/handback", async (request) => {
    const workspaceId = request.params.id as WorkspaceId;
    ctx.workspaces.mustGet(workspaceId);
    const by = author(request);
    // The holder hands back; an Admin may also free a browser someone left held. A Member who
    // does not hold it cannot end another person's lease.
    if (
      typeof ctx.locks.humanHolder(workspaceId) === "string" &&
      !isHolder(request, workspaceId) &&
      !roleAtLeast(requestRole(request), "admin")
    )
      throw new DeskmatesError("forbidden", "another person holds this browser", {
        reason: "not_holder",
      });
    // Idempotent: a second hand back, or one after the TTL expired, is a 200 that changes
    // nothing. Only a release that actually freed the browser is worth an event and a frame.
    releaseLease(workspaceId, by);
    return { released: true };
  });
}
