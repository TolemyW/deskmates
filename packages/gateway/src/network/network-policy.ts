// Online network-profile changes (ADR-0027 amendment 1 decisions 7, 8 and 13): validate and
// commit the durable change, then publish to exactly the affected workspaces, each under the
// workspace policy lock allowlist edits use, recomputing its policy from the database there.

import {
  DeskmatesError,
  type NetworkProfile,
  type NetworkPublication,
  type SandboxHandle,
  type WorkspaceId,
  type WorkspaceNetworkSelection,
  type WorkspaceNetworkView,
  isOpenInternetAllowlist,
  parseNetworkExpiry,
} from "@deskmates/contracts";
import type { GatewayContext } from "../context.js";
import type { GatewayDb } from "../db/open.js";
import { type NetworkProfileInput, NetworkProfileStore } from "./network-profile-store.js";

/** Shown before a change: a reload closes the affected workspace's external connections. */
export const NETWORK_PROFILE_NOTE =
  "Publishing a change reloads the network proxy of each workspace that selects the profile and closes its existing external connections. Workspaces that do not select it are not touched.";

const profileQueues = new WeakMap<GatewayDb, Promise<unknown>>();

/** Profile edits run one at a time per Gateway database (decision 7). */
function serialized<T>(db: GatewayDb, operation: () => Promise<T>): Promise<T> {
  const previous = profileQueues.get(db) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  profileQueues.set(db, next);
  return next;
}

export function networkProfiles(ctx: GatewayContext): NetworkProfileStore {
  return new NetworkProfileStore(ctx.db);
}

/** Decision 13: an open-internet workspace never holds LAN grants. */
export function assertNoGrantsOnOpenInternet(
  ctx: GatewayContext,
  workspaceId: WorkspaceId,
  allowlist: readonly string[],
): void {
  if (!isOpenInternetAllowlist(allowlist)) return;
  if (networkProfiles(ctx).selections(workspaceId).length === 0) return;
  throw new DeskmatesError(
    "validation",
    "an open-internet (*) workspace cannot select network profiles; lock its allowlist first or clear its profiles",
    { reason: "open_internet_with_network_profiles", workspaceId },
  );
}

/**
 * Publish the workspace's current durable policy. Call with the workspace policy lock held
 * (`withPolicyUpdate`); `peek` is that lock's handle lookup. A workspace with no sandbox is
 * `not_running`: its next start creates or reattaches with the durable policy anyway.
 */
async function publishLocked(
  ctx: GatewayContext,
  workspaceId: WorkspaceId,
  peek: () => Promise<SandboxHandle | undefined>,
  by: string,
): Promise<NetworkPublication> {
  let outcome: NetworkPublication;
  try {
    const handle = await peek();
    if (handle === undefined) {
      outcome = { workspaceId, status: "not_running" };
    } else {
      const workspace = ctx.workspaces.mustGet(workspaceId);
      const grants = networkProfiles(ctx).grantsFor(workspaceId);
      const ack = await ctx.provider.updateEgress(handle, workspace.egressAllowlist, grants);
      outcome = {
        workspaceId,
        status: ack === undefined || ack.reloaded ? "applied" : "unchanged",
        ...(ack === undefined ? {} : { policyHash: ack.policyHash }),
      };
    }
  } catch (error) {
    // Decision 8: the provider has stopped the proxy (no route rather than a stale grant). The
    // database stays the truth; the next sandbox use reattaches and pushes it again.
    outcome = { workspaceId, status: "failed", error: String(error) };
  }
  ctx.audit.record({
    action: "network_policy.publish",
    actor: by,
    workspaceId,
    targetKind: "workspace",
    targetId: workspaceId,
    after: {
      status: outcome.status,
      ...(outcome.policyHash === undefined ? {} : { policyHash: outcome.policyHash }),
    },
    ...(outcome.error === undefined ? {} : { reason: outcome.error.slice(0, 500) }),
  });
  if (outcome.status === "applied" || outcome.status === "failed") {
    for (const run of ctx.runs.listLiveInWorkspace(workspaceId)) {
      ctx.events.append({
        runId: run.id,
        kind: "log",
        payload: { source: "egress", op: "network_profiles_published", by, status: outcome.status },
      });
    }
  }
  return outcome;
}

export function publishWorkspaceNetwork(
  ctx: GatewayContext,
  workspaceId: WorkspaceId,
  by: string,
): Promise<NetworkPublication> {
  return ctx.sandboxes.withPolicyUpdate(workspaceId, (peek) =>
    publishLocked(ctx, workspaceId, peek, by),
  );
}

async function publishAll(
  ctx: GatewayContext,
  workspaceIds: readonly string[],
  by: string,
): Promise<NetworkPublication[]> {
  const outcomes: NetworkPublication[] = [];
  for (const id of workspaceIds)
    outcomes.push(await publishWorkspaceNetwork(ctx, id as WorkspaceId, by));
  return outcomes;
}

export function createNetworkProfile(
  ctx: GatewayContext,
  input: NetworkProfileInput,
  by: string,
  tenantId: string,
): Promise<NetworkProfile> {
  // Nothing selects a new profile yet, so nothing is published.
  return serialized(ctx.db, async () => networkProfiles(ctx).create(input, by, tenantId));
}

export function replaceNetworkProfile(
  ctx: GatewayContext,
  id: string,
  input: NetworkProfileInput,
  expectedRevision: number | undefined,
  by: string,
  tenantId: string,
): Promise<{ profile: NetworkProfile; publications: NetworkPublication[] }> {
  return serialized(ctx.db, async () => {
    const store = networkProfiles(ctx);
    const profile = store.replace(id, input, expectedRevision, by, tenantId);
    return { profile, publications: await publishAll(ctx, store.workspacesSelecting(id), by) };
  });
}

export function deleteNetworkProfile(
  ctx: GatewayContext,
  id: string,
  by: string,
  tenantId: string,
): Promise<{ profile: NetworkProfile; publications: NetworkPublication[] }> {
  return serialized(ctx.db, async () => {
    const store = networkProfiles(ctx);
    const affected = store.workspacesSelecting(id);
    const profile = store.delete(id, by, tenantId);
    return { profile, publications: await publishAll(ctx, affected, by) };
  });
}

/** Parse `{selections: [{profileId, expiresAt?}]}` whole before anything changes. */
export function parseSelections(value: unknown): { profileId: string; expiresAt?: string }[] {
  if (!Array.isArray(value) || value.length > 16)
    throw new DeskmatesError("validation", "selections must be a list of at most 16 entries");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new DeskmatesError("validation", "invalid selection");
    const x = item as Record<string, unknown>;
    if (typeof x.profileId !== "string" || x.profileId === "")
      throw new DeskmatesError("validation", "selection profileId is required");
    const expiresAt = parseNetworkExpiry(x.expiresAt, "selection");
    return { profileId: x.profileId, ...(expiresAt === undefined ? {} : { expiresAt }) };
  });
}

export function setWorkspaceNetworkProfiles(
  ctx: GatewayContext,
  workspaceId: WorkspaceId,
  selections: readonly { profileId: string; expiresAt?: string }[],
  by: string,
): Promise<{ selections: WorkspaceNetworkSelection[]; publication: NetworkPublication }> {
  return ctx.sandboxes.withPolicyUpdate(workspaceId, async (peek) => {
    const workspace = ctx.workspaces.mustGet(workspaceId);
    if (selections.length > 0 && isOpenInternetAllowlist(workspace.egressAllowlist))
      throw new DeskmatesError(
        "validation",
        "an open-internet (*) workspace cannot select network profiles; lock its allowlist first",
        { reason: "open_internet_with_network_profiles", workspaceId },
      );
    const stored = networkProfiles(ctx).setSelections(workspaceId, selections, by);
    return { selections: stored, publication: await publishLocked(ctx, workspaceId, peek, by) };
  });
}

export function workspaceNetworkView(
  ctx: GatewayContext,
  workspaceId: WorkspaceId,
): WorkspaceNetworkView {
  ctx.workspaces.mustGet(workspaceId);
  const store = networkProfiles(ctx);
  const selections = store.selections(workspaceId);
  return {
    workspaceId,
    trustedTest: selections.length > 0,
    selections,
    grants: store.grantsFor(workspaceId),
  };
}
