// Optional ADR-0007 admission. Registered inside the authenticated sidecar route scope.
import {
  type BrowserOriginRequest,
  DeskmatesError,
  type RunId,
  isExecuting,
} from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import type { GatewayContext } from "../context.js";
import { asRecord } from "./validate.js";

function lastOriginOperation(
  ctx: GatewayContext,
  runId: RunId,
  origin: string,
): string | undefined {
  const events = ctx.events.list(runId);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const payload = events[index]?.payload;
    if (payload?.source === "browser_origin" && payload.origin === origin) {
      return typeof payload.op === "string" ? payload.op : undefined;
    }
  }
  return undefined;
}

function parseOrigin(value: unknown): string {
  if (typeof value !== "string")
    throw new DeskmatesError("validation", "origin must be a URL origin");
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error("not an origin");
    return url.origin;
  } catch {
    throw new DeskmatesError(
      "validation",
      "origin must be an HTTP(S) origin without credentials or a path",
    );
  }
}

export function registerBrowserOriginRoutes(scope: FastifyInstance, ctx: GatewayContext): void {
  scope.post<{ Params: { runId: string } }>(
    "/internal/runs/:runId/browser-origin",
    async (request) => {
      const runId = request.params.runId as RunId;
      const run = ctx.runs.mustGet(runId);
      if (run.config.browserCoordinationMode !== "origin-v2")
        throw new DeskmatesError("validation", "origin coordination is not enabled for this run");
      if (!isExecuting(run.status))
        throw new DeskmatesError("invalid_transition", "origin coordination requires a live run");
      const body = asRecord(request.body);
      if (body.op !== "acquire" && body.op !== "renew" && body.op !== "release")
        throw new DeskmatesError("validation", "op must be acquire, renew or release");
      const req: BrowserOriginRequest = { type: "browser_origin", runId, op: body.op };
      if (body.origin !== undefined) req.origin = parseOrigin(body.origin);
      if (req.op === "acquire" && req.origin === undefined)
        throw new DeskmatesError("validation", "acquire requires an origin");
      const workspaceId = ctx.bots.mustGet(run.botId).workspaceId;
      const before = ctx.originQueue.list(workspaceId).find((entry) => entry.runId === runId);
      const result = ctx.originQueue.handle(workspaceId, req, ctx.locks.humanHolds(workspaceId));
      const after = ctx.originQueue.list(workspaceId).find((entry) => entry.runId === runId);
      if (before && before.id !== after?.id)
        ctx.events.append({
          runId,
          kind: "log",
          payload: {
            source: "browser_origin",
            op: "released",
            origin: before.origin,
            reason: req.op === "release" ? "client" : "origin_switch",
            waitedMs: Math.max(
              0,
              Date.parse(before.grantedAt ?? new Date().toISOString()) -
                Date.parse(before.queuedAt),
            ),
          },
        });
      if (after && (before?.id !== after.id || before.status !== after.status))
        ctx.events.append({
          runId,
          kind: "log",
          payload: {
            source: "browser_origin",
            op: after.status === "held" ? "granted" : "queued",
            origin: after.origin,
            queueId: after.id,
            waitedMs: Math.max(
              0,
              Date.parse(after.grantedAt ?? new Date().toISOString()) - Date.parse(after.queuedAt),
            ),
            deadlineIncludesWait: true,
          },
        });
      if (
        result.waitReason === "lease_lost" &&
        req.origin !== undefined &&
        lastOriginOperation(ctx, runId, req.origin) !== "lease_lost"
      )
        ctx.events.append({
          runId,
          kind: "log",
          payload: {
            source: "browser_origin",
            op: "lease_lost",
            origin: req.origin,
          },
        });
      return result;
    },
  );
}
