// Demo routes of published apps (ADR-0035): one app the chief published in each workspace,
// created lazily with fixed ids. The demo has no containers and no app listener, so the app is
// reported as not running and opening it explains why; stopping sharing works.

import type { AppShare } from "@deskmates/contracts";
import type { DemoFeature, DemoRequest } from "../../demo/feature.js";
import { type Result, notFound, ok } from "../../demo/result.js";
import type { DemoState } from "../../demo/state.js";

const AT = "2026-10-14T09:00:00.000Z";

const store = (s: DemoState) => s.store("app-shares", () => ({}) as Record<string, AppShare[]>);

function sharesOf(s: DemoState, workspaceId: string): AppShare[] {
  const st = store(s);
  st[workspaceId] ??= [
    {
      id: "app_0d3m0000000000000000000000000001",
      workspaceId,
      port: 3000,
      label: "Incident tracker",
      url: "http://0d3m0000000000000000000000000001.apps.localhost:8790/",
      botId: null,
      runId: null,
      createdAt: AT,
      revokedAt: null,
      revokedBy: null,
      state: "unavailable",
      reason: "workspace_stopped",
    },
  ];
  return st[workspaceId];
}

function route(req: DemoRequest, s: DemoState): Result | undefined {
  const match = req.match(/^\/api\/workspaces\/([^/]+)\/app-shares(?:\/([^/]+)(\/open)?)?$/);
  if (!match) return undefined;
  const workspaceId = decodeURIComponent(match[1] ?? "");
  if (!s.workspaces.some((w) => w.id === workspaceId)) return notFound("workspace");
  const shares = sharesOf(s, workspaceId);
  if (!match[2]) return req.method === "GET" ? ok({ enabled: true, shares }) : undefined;
  const index = shares.findIndex((share) => share.id === decodeURIComponent(match[2] ?? ""));
  const share = shares[index];
  if (!share || share.revokedAt) return notFound("app");
  if (match[3] && req.method === "POST")
    return {
      status: 409,
      json: {
        code: "invalid_transition",
        message: "The demo has no workspace containers, so its apps cannot be opened.",
        details: {},
      },
    };
  if (!match[3] && req.method === "DELETE") {
    const revoked: AppShare = {
      ...share,
      revokedAt: new Date().toISOString(),
      revokedBy: "user:root",
      state: "revoked",
    };
    shares[index] = revoked;
    return ok({ share: revoked });
  }
  return undefined;
}

export const demo: DemoFeature = { route };
