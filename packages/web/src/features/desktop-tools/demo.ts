// Demo routes of the desktop tools (ADR-0048 decision 1, amendment 1 A1): the demo Gateway's
// workspace image does not declare the capability, so a workspace reads as off by default and
// turning it on is refused, as the Gateway refuses it on the default image.

import type { DesktopToolsView } from "@deskmates/contracts";
import type { DemoFeature, DemoRequest } from "../../demo/feature.js";
import { type Result, notFound, ok } from "../../demo/result.js";
import type { DemoState } from "../../demo/state.js";

function view(s: DemoState, workspaceId: string): DesktopToolsView {
  return {
    workspaceId,
    enabled: false,
    setting: "default",
    image: "not_capable",
    bots: s.bots
      .filter((b) => b.workspaceId === workspaceId)
      .map((b) => ({ botId: b.id, name: b.name, enabled: false, setting: "default" as const })),
    groupingException: false,
  };
}

function route(req: DemoRequest, s: DemoState): Result | undefined {
  const match = req.match(/^\/api\/workspaces\/([^/]+)\/desktop-tools$/);
  if (!match) return undefined;
  const workspaceId = decodeURIComponent(match[1] ?? "");
  if (!s.workspaces.some((w) => w.id === workspaceId)) return notFound("workspace");
  if (req.method === "GET") return ok({ desktopTools: view(s, workspaceId) });
  if (req.method === "PUT") {
    if (req.body.enabled === true)
      return {
        status: 400,
        json: {
          code: "validation",
          message: "the workspace image does not declare the desktop-lcu-v1 capability",
          details: { reason: "desktop_capability_missing" },
        },
      };
    return ok({ desktopTools: view(s, workspaceId) });
  }
  return undefined;
}

export const demo: DemoFeature = { route };
