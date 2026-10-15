// Network profiles (ADR-0027 amendment 1): the root defines named LAN grants and selects them per
// workspace; workspace Owners and Admins read their workspace's selection. Every change applies
// online and reports, per affected workspace, what its proxy acknowledged.

import { DeskmatesError, type WorkspaceId } from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import type { GatewayContext } from "../context.js";
import { detectNetworkOverlaps } from "../network/network-overlaps.js";
import {
  NETWORK_PROFILE_NOTE,
  createNetworkProfile,
  deleteNetworkProfile,
  networkProfiles,
  parseSelections,
  replaceNetworkProfile,
  setWorkspaceNetworkProfiles,
  workspaceNetworkView,
} from "../network/network-policy.js";
import { preflightWorkspaceNetwork } from "../network/network-preflight.js";
import { requestActorId } from "./actor.js";
import { requestTenant } from "./route-policy.js";
import { asRecord } from "./validate.js";

type IdParams = { Params: { id: string } };

function expectedRevision(body: Record<string, unknown>): number | undefined {
  const value = body.expectedRevision;
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1)
    throw new DeskmatesError("validation", "expectedRevision must be a positive integer");
  return value as number;
}

export function registerNetworkRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  app.get("/api/network-profiles", async () => ({
    profiles: networkProfiles(ctx).list(),
    note: NETWORK_PROFILE_NOTE,
  }));

  // Amendment 2 decision 15: LAN targets inside a Docker network of this daemon; advisory.
  app.get("/api/network-overlaps", async () => detectNetworkOverlaps(ctx));

  app.post("/api/network-profiles", async (request) => {
    const body = asRecord(request.body);
    const profile = await createNetworkProfile(
      ctx,
      body,
      requestActorId(request, body),
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
      requestActorId(request, body),
      requestTenant(request),
    );
  });

  app.delete<IdParams>("/api/network-profiles/:id", async (request) =>
    deleteNetworkProfile(
      ctx,
      request.params.id,
      requestActorId(request, undefined),
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
      requestActorId(request, body),
    );
    return { ...result, network: workspaceNetworkView(ctx, id), note: NETWORK_PROFILE_NOTE };
  });
}
