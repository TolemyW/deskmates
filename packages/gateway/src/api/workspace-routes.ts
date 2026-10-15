// Operator-facing workspace routes: list, create, detail, the egress allowlist and restart
// (packages/gateway/docs/http-api.md).

import type { WorkspaceId } from "@deskmates/contracts";
import {
  DeskmatesError,
  EGRESS_OPEN_INTERNET,
  TENANT_ROLES,
  type TenantRole,
  WORKSPACE_DIRECTORY_PAGE,
  WORKSPACE_DIRECTORY_QUERY_MAX,
  decidedByHuman,
  egressAllowlistProblem,
  isWorkspaceDirectoryFilter,
} from "@deskmates/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { GatewayContext } from "../context.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import { EGRESS_EDIT_NOTE, replaceEgressAllowlist } from "../workspaces/egress-policy.js";
import { type DirectoryViewer, WorkspaceDirectory } from "../workspaces/workspace-directory.js";
import { requestActorId } from "./actor.js";
import { workspacesByIds } from "./name-lookup.js";
import { parseOffsetQuery } from "./pagination.js";
import { requestTenant } from "./route-policy.js";
import { humanBrowserLock, workspaceHasTakeoverScreen } from "./takeover-routes.js";
import { asRecord, optionalString, optionalStringArray, requireString } from "./validate.js";
import { readableWorkspaceIds } from "./workspace-access.js";

export { EGRESS_EDIT_NOTE } from "../workspaces/egress-policy.js";

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  ctx: GatewayContext,
  scheduler: Scheduler,
): void {
  const directory = new WorkspaceDirectory(ctx.db);

  // The paged directory behind User Settings › Workspaces and the switcher (ADR-0034 decision 3).
  app.get<{ Querystring: Record<string, unknown> }>("/api/workspace-directory", async (request) => {
    const { offset, limit } = parseOffsetQuery(request.query, WORKSPACE_DIRECTORY_PAGE);
    const filter = request.query.filter ?? "all";
    if (!isWorkspaceDirectoryFilter(filter))
      throw new DeskmatesError("validation", "filter must be all, pinned or archived", {
        field: "filter",
      });
    const role = request.query.role;
    if (role !== undefined && role !== "" && !TENANT_ROLES.includes(role as TenantRole))
      throw new DeskmatesError("validation", "role must be owner, admin, member or guest", {
        field: "role",
      });
    const q = request.query.q;
    if (q !== undefined && (typeof q !== "string" || q.length > WORKSPACE_DIRECTORY_QUERY_MAX))
      throw new DeskmatesError(
        "validation",
        `q must be text of at most ${WORKSPACE_DIRECTORY_QUERY_MAX} characters`,
        { field: "q" },
      );
    const page = directory.page({
      tenantId: requestTenant(request),
      viewer: directoryViewer(ctx, request),
      filter,
      ...(role ? { role: role as TenantRole } : {}),
      ...(typeof q === "string" && q ? { q } : {}),
      offset,
      limit,
    });
    return { workspaces: page.workspaces, offset, limit, total: page.total };
  });

  // The caller's own pin (ADR-0034 decision 6): a personal preference, not configuration.
  for (const [method, pinned] of [
    ["PUT", true],
    ["DELETE", false],
  ] as const) {
    app.route<{ Params: { id: string } }>({
      method,
      url: "/api/workspaces/:id/pin",
      handler: async (request) => {
        const id = request.params.id as WorkspaceId;
        ctx.workspaces.mustGet(id);
        const userId = directoryViewer(ctx, request).userId;
        if (userId === undefined)
          throw new DeskmatesError(
            "validation",
            "pins belong to a person; this principal has none",
          );
        directory.setPinned(userId, id, pinned);
        return { workspaceId: id, pinned };
      },
    });
  }

  // Only the workspaces the caller belongs to (ADR-0022 amendment 6 W1).
  app.get<{ Querystring: { ids?: string } }>("/api/workspaces", async (request) => {
    // A name lookup asks for the workspaces it labels, at most 100 (#113 §3.2).
    if (request.query.ids !== undefined)
      return { workspaces: workspacesByIds(ctx, request, request.query.ids) };
    const readable = readableWorkspaceIds(ctx, request, "guest");
    return {
      workspaces: ctx.workspaces
        .list(requestTenant(request))
        .filter((workspace) => readable === undefined || readable.has(workspace.id)),
    };
  });

  app.post("/api/workspaces", async (request, reply) => {
    const body = asRecord(request.body);
    const providerRaw = optionalString(body, "sandboxProvider") ?? ctx.config.sandboxProvider;
    if (providerRaw !== "docker" && providerRaw !== "desktop-vm") {
      throw new DeskmatesError("validation", "sandboxProvider must be docker or desktop-vm");
    }
    const probeUrl = optionalString(body, "probeUrl");
    // ADR-0020 decision 1: a workspace created without a list browses the open public internet.
    // A creator who wants a locked workspace sends the list, an empty one included.
    const egressAllowlist = optionalStringArray(body, "egressAllowlist") ?? [EGRESS_OPEN_INTERNET];
    const workspace = ctx.workspaces.create({
      // A workspace belongs to the tenant it was created in, for good (ADR-0022).
      tenantId: requestTenant(request),
      name: requireString(body, "name"),
      sandboxProvider: providerRaw,
      ...(probeUrl
        ? { probe: { url: probeUrl, expectText: optionalString(body, "probeExpectText") ?? "" } }
        : {}),
      egressAllowlist,
      createdBy: decidedByHuman(requestActorId(request, body)),
      ...(request.principal?.kind === "user" ? { ownerUserId: request.principal.userId } : {}),
    });
    return reply.code(201).send({ workspace });
  });

  app.get<{ Params: { id: string } }>("/api/workspaces/:id", async (request) => {
    const id = request.params.id as WorkspaceId;
    return {
      workspace: ctx.workspaces.mustGet(id),
      bots: ctx.bots.list(id),
      capacity: scheduler.capacity(id),
      // The takeover state of the one shared browser: who holds it, and whether its screen is
      // up. The screen is reached through the proxy only, never by address (ADR-0022 amd. 1).
      browserLock: humanBrowserLock(ctx, id),
      takeoverScreen: await workspaceHasTakeoverScreen(ctx, id),
    };
  });

  /**
   * The one editable part of a workspace: its egress allowlist. Replacing it is an operator
   * action — the agent has no route to this — and every run that is live right now is told what
   * changed, so a call that starts failing has the reason in its own transcript.
   */
  app.patch<{ Params: { id: string } }>("/api/workspaces/:id", async (request) => {
    const id = request.params.id as WorkspaceId;
    const body = asRecord(request.body);
    const patterns = optionalStringArray(body, "egressAllowlist");
    const name = body.name === undefined ? undefined : requireString(body, "name");
    if (!patterns && name === undefined) {
      throw new DeskmatesError(
        "validation",
        "send name or egressAllowlist (an array) to update the workspace",
      );
    }
    const by = decidedByHuman(requestActorId(request, body));
    // A rename is checked before the allowlist is touched, so an invalid name changes nothing
    // (ADR-0034 decision 2), and the allowlist before the rename commits.
    const listProblem = patterns ? egressAllowlistProblem(patterns) : undefined;
    if (listProblem !== undefined) throw new DeskmatesError("validation", listProblem);
    const renamed = name === undefined ? undefined : ctx.workspaces.rename(id, name, by);
    if (renamed && !patterns) {
      ctx.bus.publish({ type: "workspace", workspaceId: id, workspace: renamed });
      return { workspace: renamed };
    }
    const { workspace } = await replaceEgressAllowlist(ctx, id, patterns ?? [], by);
    return { workspace, note: EGRESS_EDIT_NOTE };
  });

  app.get<{ Params: { id: string } }>("/api/workspaces/:id/restart-preflight", async (request) => ({
    prerequisites: await ctx.sandboxes.replacementPreflight(request.params.id as WorkspaceId),
  }));

  /**
   * Recreate the workspace container so it starts with the current allowlist in
   * `DESKMATES_EGRESS_ALLOWLIST`. The named volumes (`/profile`, `/work`, `/home`) are not the
   * container and survive it, so the browser profile, the login state and the bots' homes come
   * back. A live run would lose its sidecar mid-call, so the route refuses instead.
   */
  app.post<{ Params: { id: string } }>("/api/workspaces/:id/restart", async (request) => {
    const id = request.params.id as WorkspaceId;
    ctx.workspaces.mustGet(id);
    const live = ctx.runs.listLiveInWorkspace(id);
    if (live.length > 0) {
      throw new DeskmatesError("lane_busy", "the workspace has runs with a live sidecar", {
        workspaceId: id,
        liveRuns: live.map((r) => r.id),
      });
    }
    const { handle, restorationRequirements } = await scheduler.withIdleWorkspace(id, () =>
      ctx.sandboxes.restart(id),
    );
    // The screen a human was watching went away with the container, so the takeover ends here
    // rather than leaving every bot in the workspace waiting on a lock nobody can hand back.
    if (ctx.locks.humanHolds(id)) {
      ctx.locks.humanRelease(id);
      ctx.bus.publish({ type: "workspace_lock", workspaceId: id, browserLock: null });
    }
    // Only what an operator needs: no sidecar or noVNC address, no environment, no token.
    // `restorationRequirements` are this restart's findings; notices stored by earlier
    // operations that are still on record are listed separately, labelled as outstanding.
    const own = new Set(
      restorationRequirements.map((r) => JSON.stringify([r.code, r.path, r.sourceProviderRef])),
    );
    return {
      handle: { providerRef: handle.providerRef },
      restorationRequirements,
      outstandingRestorationRequirements: (
        ctx.workspaces.mustGet(id).restorationRequirements ?? []
      ).filter((r) => !own.has(JSON.stringify([r.code, r.path, r.sourceProviderRef]))),
    };
  });
}

/** The directory's view of the caller (ADR-0022 amendment 6 W1 through `readableWorkspaceIds`). */
function directoryViewer(ctx: GatewayContext, request: FastifyRequest): DirectoryViewer {
  const principal = request.principal;
  if (!principal || principal.kind === "operator_token") return { everywhere: "owner" };
  if (principal.kind === "service") return { everywhere: principal.role };
  return readableWorkspaceIds(ctx, request, "guest") === undefined
    ? { userId: principal.userId, everywhere: "owner" }
    : { userId: principal.userId };
}
