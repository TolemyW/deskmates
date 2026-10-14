// Demo routes of the workspace switcher and dialogs: list, create, the workspace detail with its
// browser lock and capacity, egress allowlist edits and renames, and the paged directory with
// pins (ADR-0034). The demo session is the Owner of every workspace.

import {
  WORKSPACE_DIRECTORY_PAGE,
  type WorkspaceDirectoryEntry,
  describeWorkspaceNameProblem,
  isOpenInternetAllowlist,
  workspaceNameProblem,
} from "@deskmates/contracts";
import type { DemoFeature, DemoRequest } from "../../demo/feature.js";
import { type Result, created, notFound, ok } from "../../demo/result.js";
import { type DemoState, minutesAgo } from "../../demo/state.js";

export const demo: DemoFeature = { route };

const pins = new WeakMap<DemoState, Set<string>>();

function pinsOf(s: DemoState): Set<string> {
  let set = pins.get(s);
  if (!set) {
    set = new Set();
    pins.set(s, set);
  }
  return set;
}

function botIds(s: DemoState, workspaceId: string): Set<string> {
  return new Set(s.bots.filter((bot) => bot.workspaceId === workspaceId).map((bot) => bot.id));
}

/** `GET /api/workspace-directory` over the demo's workspaces, as the Gateway pages it. */
function directory(req: DemoRequest, s: DemoState): Result {
  const q = (req.query.get("q") ?? "").trim().toLowerCase();
  const filter = req.query.get("filter") ?? "all";
  const role = req.query.get("role");
  const offset = Number(req.query.get("offset") ?? 0);
  const limit = Number(req.query.get("limit") ?? WORKSPACE_DIRECTORY_PAGE.default);
  const pinned = pinsOf(s);
  const activity = (id: string, fallback: string) =>
    s.threads
      .filter((thread) => thread.workspaceId === id)
      .map((thread) => thread.updatedAt)
      .reduce((latest, at) => (at > latest ? at : latest), fallback);
  const rows: WorkspaceDirectoryEntry[] = s.workspaces
    .filter((w) => (filter === "archived" ? Boolean(w.archivedAt) : !w.archivedAt))
    .filter((w) => filter !== "pinned" || pinned.has(w.id))
    .filter((w) => !role || role === "owner")
    .filter((w) => !q || w.name.toLowerCase().includes(q) || w.id === q)
    .map((w) => ({
      id: w.id,
      name: w.name,
      myRole: "owner" as const,
      pinned: pinned.has(w.id),
      botCount: s.bots.filter((bot) => bot.workspaceId === w.id && !bot.archivedAt).length,
      activeRuns: s.active().filter((run) => botIds(s, w.id).has(run.botId)).length,
      lastActivityAt: activity(w.id, w.createdAt),
      createdAt: w.createdAt,
      ...(w.archivedAt ? { archivedAt: w.archivedAt } : {}),
      openInternet: isOpenInternetAllowlist(w.egressAllowlist),
    }))
    .sort((a, b) =>
      a.lastActivityAt === b.lastActivityAt
        ? a.id.localeCompare(b.id)
        : b.lastActivityAt.localeCompare(a.lastActivityAt),
    );
  return ok({ workspaces: rows.slice(offset, offset + limit), offset, limit, total: rows.length });
}

function route(req: DemoRequest, s: DemoState): Result | Promise<Result> | undefined {
  const { method, path, body: b } = req;
  const m = (re: RegExp) => req.match(re);
  let x: RegExpMatchArray | null;
  if (path === "/api/workspaces" && method === "GET") return ok({ workspaces: s.workspaces });
  if (path === "/api/workspace-directory" && method === "GET") return directory(req, s);
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/workspaces\/([^/]+)\/pin$/)) && (method === "PUT" || method === "DELETE")) {
    const id = decodeURIComponent(x[1] ?? "");
    const set = pinsOf(s);
    if (method === "PUT") set.add(id);
    else set.delete(id);
    return ok({ workspaceId: id, pinned: method === "PUT" });
  }
  if (path === "/api/workspaces" && method === "POST") {
    const workspace = s.addWorkspace(
      String(b.name ?? "workspace"),
      (b.egressAllowlist as string[]) ?? ["*"],
    );
    return created({ workspace });
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/workspaces\/([^/]+)$/))) {
    const ws = s.workspaces.find((w) => w.id === decodeURIComponent(x?.[1] ?? ""));
    if (!ws) return notFound("workspace");
    if (method === "PATCH") {
      if (typeof b.name === "string" && b.name !== ws.name) {
        const problem = workspaceNameProblem(b.name);
        if (problem)
          return {
            status: 400,
            json: { code: "validation", message: describeWorkspaceNameProblem(problem) },
          };
        ws.name = b.name.normalize("NFC");
      }
      if (Array.isArray(b.egressAllowlist))
        Object.assign(ws, {
          egressAllowlist: b.egressAllowlist as string[],
          egressUpdatedAt: new Date().toISOString(),
        });
      return ok({ workspace: ws });
    }
    return ok({
      workspace: ws,
      bots: s.bots.filter((bot) => bot.workspaceId === ws.id),
      browserLock: s.humanHolds
        ? {
            workspaceId: ws.id,
            holderKind: "human",
            acquiredAt: new Date().toISOString(),
            expiresAt: minutesAgo(-60),
          }
        : null,
      takeoverScreen: false,
      capacity: { activeAttempts: s.active().length, waitingRunIds: [] },
    });
  }
  return undefined;
}
