// In-memory Trash preview; restores change only this demo session.
import type { Workspace } from "@deskmates/contracts";
import type { DemoFeature } from "../../demo/feature.js";
import { notFound, ok } from "../../demo/result.js";
import type { DemoState } from "../../demo/state.js";

const store = (state: DemoState) => state.store("trash", () => ({ workspaces: [] as Workspace[] }));

export const demo: DemoFeature = {
  seed: {
    after: "history",
    run(state, { now }) {
      store(state).workspaces.push({
        id: "ws_demo_archived" as Workspace["id"],
        name: "Completed research",
        sandboxProvider: "docker",
        status: "ready",
        egressAllowlist: ["*"],
        egressUpdatedAt: new Date(now - 7 * 86400000).toISOString(),
        createdAt: new Date(now - 7 * 86400000).toISOString(),
        archivedAt: new Date(now - 86400000).toISOString(),
      });
    },
  },
  route(req, state) {
    const archived = store(state).workspaces;
    if (req.method === "GET" && req.path === "/api/trash") {
      const offset = Math.max(0, Number(req.query.get("offset")) || 0);
      const limit = Math.min(100, Math.max(1, Number(req.query.get("limit")) || 25));
      return ok({
        workspaces: archived.slice(offset, offset + limit),
        bots: [],
        offset,
        limit,
        total: archived.length,
      });
    }
    const match = req.path.match(/^\/api\/workspaces\/([^/]+)\/restore$/);
    if (req.method !== "POST" || !match) return undefined;
    const id = decodeURIComponent(match[1] ?? "");
    const index = archived.findIndex((workspace) => workspace.id === id);
    if (index < 0) {
      const existing = state.workspaces.find((workspace) => workspace.id === id);
      return existing ? ok({ workspace: existing }) : notFound("Workspace");
    }
    const workspace = archived[index];
    if (!workspace) return notFound("Workspace");
    const { archivedAt: _archivedAt, ...restored } = workspace;
    archived.splice(index, 1);
    state.workspaces.push(restored);
    return ok({ workspace: restored });
  },
};
