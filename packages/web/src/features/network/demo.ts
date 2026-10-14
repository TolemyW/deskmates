// Demo routes of network profiles (ADR-0027 amendment 1): one seeded "VendorDB test environment"
// profile, created lazily with fixed ids so the shared id counter and other features' records
// never move. Publications are always `applied` or `unchanged`; the demo has no proxy.

import type {
  NetworkProfile,
  NetworkRule,
  WorkspaceNetworkSelection,
  WorkspaceNetworkView,
} from "@deskmates/contracts";
import type { DemoFeature, DemoRequest } from "../../demo/feature.js";
import { type Result, created, notFound, ok } from "../../demo/result.js";
import type { DemoState } from "../../demo/state.js";

const NOTE =
  "Publishing a change reloads the network proxy of each workspace that selects the profile and closes its existing external connections. Workspaces that do not select it are not touched.";
const AT = "2026-10-14T09:00:00.000Z";

const store = (s: DemoState) =>
  s.store("network", () => ({
    next: 2,
    profiles: [
      {
        id: "netp_demo1",
        name: "VendorDB test environment",
        description: "LAN test services for functional checks",
        rules: [
          { kind: "subnet", cidr: "10.20.30.0/24", schemes: ["http"], ports: [23001] },
        ] as NetworkRule[],
        revision: 1,
        createdAt: AT,
        updatedAt: AT,
        updatedBy: "user:root",
      },
    ] as NetworkProfile[],
    selections: {} as Record<string, WorkspaceNetworkSelection[]>,
  }));

function view(s: DemoState, workspaceId: string): WorkspaceNetworkView {
  const st = store(s);
  const selections = st.selections[workspaceId] ?? [];
  const grants = selections.flatMap(
    (sel) => st.profiles.find((p) => p.id === sel.profileId)?.rules ?? [],
  );
  return { workspaceId, trustedTest: selections.length > 0, selections, grants };
}

function invalid(message: string): Result {
  return { status: 400, json: { code: "validation", message, details: {} } };
}

function input(
  b: Record<string, unknown>,
): Omit<NetworkProfile, "id" | "revision" | "createdAt" | "updatedAt" | "updatedBy"> | string {
  if (typeof b.name !== "string" || !b.name.trim())
    return "profile name must be 1 to 80 characters";
  if (!Array.isArray(b.rules) || b.rules.length === 0)
    return "rules must be a list of 1 to 64 network rules";
  return {
    name: b.name.trim(),
    description: typeof b.description === "string" ? b.description : "",
    rules: b.rules as NetworkRule[],
    ...(typeof b.expiresAt === "string" ? { expiresAt: b.expiresAt } : {}),
  };
}

function route(req: DemoRequest, s: DemoState): Result | undefined {
  const { method, path, body: b } = req;
  const st = store(s);
  const affected = (profileId: string) =>
    Object.entries(st.selections)
      .filter(([, list]) => list.some((sel) => sel.profileId === profileId))
      .map(([workspaceId]) => ({ workspaceId, status: "applied" as const }));
  if (path === "/api/network-profiles") {
    if (method === "GET") return ok({ profiles: st.profiles, note: NOTE });
    if (method === "POST") {
      const parsed = input(b);
      if (typeof parsed === "string") return invalid(parsed);
      const profile: NetworkProfile = {
        ...parsed,
        id: `netp_demo${st.next++}`,
        revision: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        updatedBy: "user:root",
      };
      st.profiles.push(profile);
      return created({ profile });
    }
  }
  const profileMatch = req.match(/^\/api\/network-profiles\/([^/]+)$/);
  if (profileMatch) {
    const id = decodeURIComponent(profileMatch[1] ?? "");
    const index = st.profiles.findIndex((p) => p.id === id);
    const current = st.profiles[index];
    if (!current) return notFound("network profile");
    if (method === "PUT") {
      if (typeof b.expectedRevision === "number" && b.expectedRevision !== current.revision)
        return {
          status: 409,
          json: {
            code: "invalid_transition",
            message: "the network profile changed since it was read",
            details: { reason: "stale_revision" },
          },
        };
      const parsed = input(b);
      if (typeof parsed === "string") return invalid(parsed);
      const profile = {
        ...current,
        ...parsed,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      st.profiles[index] = profile;
      return ok({ profile, publications: affected(id) });
    }
    if (method === "DELETE") {
      const publications = affected(id);
      st.profiles.splice(index, 1);
      for (const key of Object.keys(st.selections))
        st.selections[key] = (st.selections[key] ?? []).filter((sel) => sel.profileId !== id);
      return ok({ profile: current, publications });
    }
  }
  const wsMatch = req.match(/^\/api\/workspaces\/([^/]+)\/network(-profiles)?$/);
  if (wsMatch) {
    const workspaceId = decodeURIComponent(wsMatch[1] ?? "");
    if (!s.workspaces.some((w) => w.id === workspaceId)) return notFound("workspace");
    if (!wsMatch[2] && method === "GET") return ok(view(s, workspaceId));
    if (wsMatch[2] && method === "PUT") {
      const wanted = Array.isArray(b.selections)
        ? (b.selections as Array<{ profileId: string; expiresAt?: string }>)
        : [];
      if (wanted.some((sel) => !st.profiles.some((p) => p.id === sel.profileId)))
        return notFound("network profile");
      st.selections[workspaceId] = wanted.map((sel) => ({
        profileId: sel.profileId,
        profileName: st.profiles.find((p) => p.id === sel.profileId)?.name ?? sel.profileId,
        ...(sel.expiresAt ? { expiresAt: sel.expiresAt } : {}),
        selectedAt: new Date().toISOString(),
        selectedBy: "user:root",
      }));
      const network = view(s, workspaceId);
      return ok({
        selections: network.selections,
        publication: { workspaceId, status: "applied", policyHash: "d3m0".repeat(16) },
        network,
        note: NOTE,
      });
    }
  }
  return undefined;
}

export const demo: DemoFeature = { route };
