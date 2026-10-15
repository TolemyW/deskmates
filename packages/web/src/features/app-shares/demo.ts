// Demo routes of published apps (ADR-0035): one app the chief published in each workspace,
// created lazily with fixed ids. The demo has no containers and no app listener, so the app is
// reported as not running and opening it explains why; stopping sharing works.

import { type AppShare, appSharePortAllowed } from "@deskmates/contracts";
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
      publishedBy: null,
      createdAt: AT,
      revokedAt: null,
      revokedBy: null,
      state: "unavailable",
      reason: "workspace_stopped",
    },
  ];
  return st[workspaceId];
}

/** A person shares a port (owner-decided 2026-10-14): the same port relabels its publication. */
function publish(req: DemoRequest, shares: AppShare[], workspaceId: string): Result {
  const port = req.body.port;
  const label = typeof req.body.label === "string" ? req.body.label.trim() : "";
  if (typeof port !== "number" || !appSharePortAllowed(port) || label === "")
    return {
      status: 400,
      json: { code: "validation", message: "port and label are required", details: {} },
    };
  const current = shares.find((s) => s.port === port && !s.revokedAt);
  if (current) {
    current.label = label;
    return ok({ share: current, existing: true });
  }
  const hex = (shares.length + 1).toString(16).padStart(32, "0");
  const share: AppShare = {
    id: `app_${hex}`,
    workspaceId,
    port,
    label,
    url: `http://${hex}.apps.localhost:8790/`,
    botId: null,
    runId: null,
    publishedBy: "user:root",
    createdAt: new Date().toISOString(),
    revokedAt: null,
    revokedBy: null,
    state: "unavailable",
    reason: "workspace_stopped",
  };
  shares.unshift(share);
  return ok({ share, existing: false });
}

function route(req: DemoRequest, s: DemoState): Result | undefined {
  const match = req.match(/^\/api\/workspaces\/([^/]+)\/app-shares(?:\/([^/]+)(\/open)?)?$/);
  if (!match) return undefined;
  const workspaceId = decodeURIComponent(match[1] ?? "");
  if (!s.workspaces.some((w) => w.id === workspaceId)) return notFound("workspace");
  const shares = sharesOf(s, workspaceId);
  if (!match[2] && req.method === "POST") return publish(req, shares, workspaceId);
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
