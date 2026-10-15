// Online network-profile changes (ADR-0027 amendment 1 decisions 7, 8, 12 and 13): check who may
// make the change, validate and commit it, then publish to exactly the affected workspaces, each
// under the workspace policy lock allowlist edits use, recomputing its policy from the database.

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

/**
 * Who changes a profile or a selection (decision 12, owner-decided 2026-10-14): the root manages
 * every profile; a workspace Owner manages the profiles they created; `userId` is the person.
 */
export interface NetworkActor {
  /** The ledger label. */
  by: string;
  root: boolean;
  userId?: string;
}

/**
 * Decision 13 (owner-decided 2026-10-14): an open-internet workspace holds LAN grants only while
 * its `profilesOnOpenInternet` switch is on, which is the default.
 */
export function assertNoGrantsOnOpenInternet(
  ctx: GatewayContext,
  workspaceId: WorkspaceId,
  allowlist: readonly string[],
): void {
  if (!isOpenInternetAllowlist(allowlist)) return;
  const store = networkProfiles(ctx);
  if (store.profilesOnOpenInternet(workspaceId)) return;
  if (store.selections(workspaceId).length === 0) return;
  throw new DeskmatesError(
    "validation",
    "this workspace does not allow network profiles on the open internet (*); lock its allowlist first, clear its profiles or turn the setting on",
    { reason: "open_internet_with_network_profiles", workspaceId },
  );
}

/** The root, or the profile's creator; anyone else is refused (decision 12). */
function assertMayEdit(profile: NetworkProfile, actor: NetworkActor): void {
  if (actor.root) return;
  if (actor.userId !== undefined && profile.ownerUserId === actor.userId) return;
  throw new DeskmatesError(
    "forbidden",
    "only the administrator account or the Owner who created this profile may change it",
    { reason: "profile_owner" },
  );
}

/** The profile list a caller sees, each marked with whether they may edit it (decision 12). */
export function visibleNetworkProfiles(ctx: GatewayContext, actor: NetworkActor): NetworkProfile[] {
  const store = networkProfiles(ctx);
  if (actor.root) return store.list().map((p) => ({ ...p, editable: true }));
  if (actor.userId === undefined) return [];
  return store
    .visibleToOwner(actor.userId)
    .map((p) => ({ ...p, editable: p.ownerUserId === actor.userId }));
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
  actor: NetworkActor,
  tenantId: string,
): Promise<NetworkProfile> {
  // A workspace Owner's profile names its creator; the root's is available everywhere.
  const owner = actor.root ? undefined : actor.userId;
  if (!actor.root && owner === undefined)
    throw new DeskmatesError("forbidden", "only a person who owns a workspace creates profiles", {
      reason: "profile_owner",
    });
  // Nothing selects a new profile yet, so nothing is published.
  return serialized(ctx.db, async () =>
    networkProfiles(ctx).create(input, actor.by, tenantId, owner),
  );
}

export function replaceNetworkProfile(
  ctx: GatewayContext,
  id: string,
  input: NetworkProfileInput,
  expectedRevision: number | undefined,
  actor: NetworkActor,
  tenantId: string,
): Promise<{ profile: NetworkProfile; publications: NetworkPublication[] }> {
  return serialized(ctx.db, async () => {
    const store = networkProfiles(ctx);
    assertMayEdit(store.mustGet(id), actor);
    const profile = store.replace(id, input, expectedRevision, actor.by, tenantId);
    return {
      profile,
      publications: await publishAll(ctx, store.workspacesSelecting(id), actor.by),
    };
  });
}

export function deleteNetworkProfile(
  ctx: GatewayContext,
  id: string,
  actor: NetworkActor,
  tenantId: string,
): Promise<{ profile: NetworkProfile; publications: NetworkPublication[] }> {
  return serialized(ctx.db, async () => {
    const store = networkProfiles(ctx);
    assertMayEdit(store.mustGet(id), actor);
    const affected = store.workspacesSelecting(id);
    const profile = store.delete(id, actor.by, tenantId);
    return { profile, publications: await publishAll(ctx, affected, actor.by) };
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
  actor: NetworkActor,
): Promise<{ selections: WorkspaceNetworkSelection[]; publication: NetworkPublication }> {
  return ctx.sandboxes.withPolicyUpdate(workspaceId, async (peek) => {
    const workspace = ctx.workspaces.mustGet(workspaceId);
    const store = networkProfiles(ctx);
    if (
      selections.length > 0 &&
      isOpenInternetAllowlist(workspace.egressAllowlist) &&
      !store.profilesOnOpenInternet(workspaceId)
    )
      throw new DeskmatesError(
        "validation",
        "this workspace does not allow network profiles on the open internet (*); lock its allowlist first or turn the setting on",
        { reason: "open_internet_with_network_profiles", workspaceId },
      );
    // Decision 12: an Admin or Owner picks among the profiles available here, and may keep a
    // selection already in place; the root may select any. Anything else is not found here.
    if (!actor.root) {
      const allowed = new Set([
        ...store.availableFor(workspaceId).map((p) => p.id),
        ...store.selections(workspaceId).map((s) => s.profileId),
      ]);
      for (const s of selections)
        if (!allowed.has(s.profileId))
          throw new DeskmatesError("not_found", "network profile not found", { id: s.profileId });
    }
    const stored = store.setSelections(workspaceId, selections, actor.by);
    return {
      selections: stored,
      publication: await publishLocked(ctx, workspaceId, peek, actor.by),
    };
  });
}

/**
 * Decision 13's switch. Turning it off on an open-internet workspace that selects a profile is
 * refused: the selection would contradict it. No grant changes, so nothing is published.
 */
export function setWorkspaceNetworkSettings(
  ctx: GatewayContext,
  workspaceId: WorkspaceId,
  profilesOnOpenInternet: boolean,
  by: string,
): Promise<void> {
  return ctx.sandboxes.withPolicyUpdate(workspaceId, async () => {
    const workspace = ctx.workspaces.mustGet(workspaceId);
    const store = networkProfiles(ctx);
    if (
      !profilesOnOpenInternet &&
      isOpenInternetAllowlist(workspace.egressAllowlist) &&
      store.selections(workspaceId).length > 0
    )
      throw new DeskmatesError(
        "validation",
        "this open-internet (*) workspace selects network profiles; clear them before turning the setting off",
        { reason: "open_internet_with_network_profiles", workspaceId },
      );
    if (store.profilesOnOpenInternet(workspaceId) !== profilesOnOpenInternet)
      store.setProfilesOnOpenInternet(workspaceId, profilesOnOpenInternet, by);
  });
}

export function workspaceNetworkView(
  ctx: GatewayContext,
  workspaceId: WorkspaceId,
): WorkspaceNetworkView {
  const workspace = ctx.workspaces.mustGet(workspaceId);
  const store = networkProfiles(ctx);
  const selections = store.selections(workspaceId);
  return {
    workspaceId,
    trustedTest: selections.length > 0,
    selections,
    grants: store.grantsFor(workspaceId),
    openInternet: isOpenInternetAllowlist(workspace.egressAllowlist),
    profilesOnOpenInternet: store.profilesOnOpenInternet(workspaceId),
    available: store.availableFor(workspaceId),
  };
}
