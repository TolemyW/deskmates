// Network profiles (ADR-0027 amendment 1, decisions 12 and 13 owner-decided 2026-10-14): the
// root and workspace Owners define named LAN grants; a workspace's Admins and Owners select the
// profiles available there and set whether an open-internet workspace may use them. Every change
// applies online and reports, per affected workspace, what its proxy acknowledged.

import { DeskmatesError, type WorkspaceId } from "@deskmates/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { GatewayContext } from "../context.js";
import { detectNetworkOverlaps } from "../network/network-overlaps.js";
import {
  NETWORK_PROFILE_NOTE,
  type NetworkActor,
  createNetworkProfile,
  deleteNetworkProfile,
  parseSelections,
  replaceNetworkProfile,
  setWorkspaceNetworkProfiles,
  setWorkspaceNetworkSettings,
  visibleNetworkProfiles,
  workspaceNetworkView,
} from "../network/network-policy.js";
import { preflightWorkspaceNetwork } from "../network/network-preflight.js";
import { requestActorId } from "./actor.js";
import { requestTenant } from "./route-policy.js";
import { asRecord } from "./validate.js";
import { isRootPrincipal } from "./workspace-access.js";

type IdParams = { Params: { id: string } };

function expectedRevision(body: Record<string, unknown>): number | undefined {
  const value = body.expectedRevision;
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1)
    throw new DeskmatesError("validation", "expectedRevision must be a positive integer");
  return value as number;
}

/** Who acts, for decision 12's root-or-creator rule and the ledger. */
function networkActor(ctx: GatewayContext, request: FastifyRequest, body: unknown): NetworkActor {
  const principal = request.principal;
  return {
    by: requestActorId(request, body),
    root: isRootPrincipal(ctx, principal),
    ...(principal?.kind === "user" ? { userId: principal.userId } : {}),
  };
}

export function registerNetworkRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  app.get("/api/network-profiles", async (request) => {
    const actor = networkActor(ctx, request, undefined);
    return {
      profiles: visibleNetworkProfiles(ctx, actor),
      note: NETWORK_PROFILE_NOTE,
      manageAll: actor.root,
    };
  });

  // Amendment 2 decision 15: LAN targets inside a Docker network of this daemon; advisory.
  app.get("/api/network-overlaps", async () => detectNetworkOverlaps(ctx));

  app.post("/api/network-profiles", async (request) => {
    const body = asRecord(request.body);
    const profile = await createNetworkProfile(
      ctx,
      body,
      networkActor(ctx, request, body),
      requestTenant(request),
    );
    return { profile };
  });

  app.put<IdParams>("/api/network-profiles/:id", async (request) => {
    const body = asRecord(request.body);
    return replaceNetworkProfile(
      ctx,
      request.params.id,
      body,
      expectedRevision(body),
      networkActor(ctx, request, body),
      requestTenant(request),
    );
  });

  app.delete<IdParams>("/api/network-profiles/:id", async (request) =>
    deleteNetworkProfile(
      ctx,
      request.params.id,
      networkActor(ctx, request, undefined),
      requestTenant(request),
    ),
  );

  app.get<IdParams>("/api/workspaces/:id/network", async (request) =>
    workspaceNetworkView(ctx, request.params.id as WorkspaceId),
  );

  app.post<IdParams>("/api/workspaces/:id/network-preflight", async (request) => {
    const body = asRecord(request.body);
    if (typeof body.url !== "string" || body.url.length > 2048)
      throw new DeskmatesError("validation", "url is required");
    return preflightWorkspaceNetwork(ctx, request.params.id as WorkspaceId, body.url);
  });

  app.put<IdParams>("/api/workspaces/:id/network-profiles", async (request) => {
    const id = request.params.id as WorkspaceId;
    ctx.workspaces.mustGet(id);
    const body = asRecord(request.body);
    const selections = parseSelections(body.selections);
    const result = await setWorkspaceNetworkProfiles(
      ctx,
      id,
      selections,
      networkActor(ctx, request, body),
    );
    return { ...result, network: workspaceNetworkView(ctx, id), note: NETWORK_PROFILE_NOTE };
  });

  // Decision 13: whether this workspace may use profiles while it browses the open internet.
  app.put<IdParams>("/api/workspaces/:id/network-settings", async (request) => {
    const id = request.params.id as WorkspaceId;
    ctx.workspaces.mustGet(id);
    const body = asRecord(request.body);
    if (typeof body.profilesOnOpenInternet !== "boolean")
      throw new DeskmatesError("validation", "profilesOnOpenInternet must be a boolean", {
        field: "profilesOnOpenInternet",
      });
    await setWorkspaceNetworkSettings(
      ctx,
      id,
      body.profilesOnOpenInternet,
      requestActorId(request, body),
    );
    return { network: workspaceNetworkView(ctx, id) };
  });
}
