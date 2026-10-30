// Sidecar-facing desktop routes (ADR-0048 amendment 1), registered inside the run-token scope of
// `api/internal-routes.ts`: the shared-screen lease of a desktop call (A3). The run's workspace is
// read from its bot, never from the request.

import {
  DeskmatesError,
  type DesktopLockRequest,
  type DesktopLockResponse,
  type RunId,
} from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import { asRecord } from "../api/validate.js";
import type { GatewayContext } from "../context.js";
import { desktopInputLocks } from "./desktop-input-lock.js";

type RunParams = { Params: { runId: string } };

const OPS: ReadonlySet<unknown> = new Set(["acquire", "probe", "release", "renew"]);

export function registerDesktopInternalRoutes(scope: FastifyInstance, ctx: GatewayContext): void {
  scope.post<RunParams>(
    "/internal/runs/:runId/desktop-lock",
    async (request): Promise<DesktopLockResponse> => {
      const runId = request.params.runId as RunId;
      const run = ctx.runs.mustGet(runId);
      const workspaceId = ctx.bots.mustGet(run.botId).workspaceId;
      const body = asRecord(request.body);
      if (!OPS.has(body.op))
        throw new DeskmatesError("validation", "op must be acquire, probe, release or renew");
      const op = body.op as DesktopLockRequest["op"];
      const callId = typeof body.callId === "string" ? body.callId.slice(0, 200) : undefined;
      if (op !== "probe" && callId === undefined)
        throw new DeskmatesError("validation", "callId is required");
      if (op === "acquire" && body.mode !== "shared" && body.mode !== "exclusive")
        throw new DeskmatesError("validation", "mode must be shared or exclusive");
      const req: DesktopLockRequest = {
        type: "desktop_lock",
        runId,
        op,
        ...(callId === undefined ? {} : { callId }),
        ...(op === "acquire" ? { mode: body.mode as "shared" | "exclusive" } : {}),
      };
      return desktopInputLocks(ctx).handle(workspaceId, req);
    },
  );
}
