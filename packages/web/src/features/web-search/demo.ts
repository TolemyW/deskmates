// Demo routes of the `web_search` switch (ADR-0049 decision 4): the demo Gateway configures a
// search service, every workspace starts at the default (on), and an Owner or Admin may turn it
// on, off or back to the default, as the Gateway allows.

import type { WebSearchView } from "@deskmates/contracts";
import type { DemoFeature, DemoRequest } from "../../demo/feature.js";
import { type Result, notFound, ok } from "../../demo/result.js";
import type { DemoState } from "../../demo/state.js";

const store = (s: DemoState) =>
  s.store("webSearch", () => ({ enabled: {} as Record<string, boolean> }));

function view(s: DemoState, workspaceId: string): WebSearchView {
  const stored = store(s).enabled[workspaceId];
  return {
    workspaceId,
    configured: true,
    enabled: stored ?? null,
    effective: stored !== false,
    defaultEnabled: true,
    updatedBy: stored === undefined ? null : "user:demo",
    updatedAt: stored === undefined ? null : "2026-10-18T09:00:00.000Z",
  };
}

function route(req: DemoRequest, s: DemoState): Result | undefined {
  const match = req.match(/^\/api\/workspaces\/([^/]+)\/web-search$/);
  if (!match) return undefined;
  const workspaceId = decodeURIComponent(match[1] ?? "");
  if (!s.workspaces.some((w) => w.id === workspaceId)) return notFound("workspace");
  if (req.method === "GET") return ok({ webSearch: view(s, workspaceId) });
  if (req.method === "PUT") {
    const enabled = req.body.enabled;
    if (enabled !== null && typeof enabled !== "boolean")
      return {
        status: 400,
        json: { code: "validation", message: "enabled must be true, false or null", details: {} },
      };
    if (enabled === null) delete store(s).enabled[workspaceId];
    else store(s).enabled[workspaceId] = enabled;
    return ok({ webSearch: view(s, workspaceId) });
  }
  return undefined;
}

export const demo: DemoFeature = { route };
