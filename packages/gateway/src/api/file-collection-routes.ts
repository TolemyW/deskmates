// ADR-0014 amendment A2: the workspace Files collection. Operator listener only, read-only and
// SQL-only: listing never peeks at, starts or execs in the workspace container (decision 14).
// Preview and download keep using `GET /api/workspaces/:id/files` (decisions 1 to 7).

import { DeskmatesError, type WorkspaceId, parseFileCollectionQuery } from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import { actorLabel } from "../auth/principal.js";
import type { GatewayContext } from "../context.js";
import { FileCollection, type FileCollectionOptions } from "../files/file-collection.js";

type CollectionRoute = { Params: { id: string }; Querystring: Record<string, unknown> };

/** Operational log line; defaults to the request logger at info level. */
export type FileCollectionLog = (msg: string, data: Record<string, unknown>) => void;

export interface FileCollectionRouteOptions extends FileCollectionOptions {
  log?: FileCollectionLog;
}

export function registerFileCollectionRoutes(
  app: FastifyInstance,
  ctx: GatewayContext,
  opts: FileCollectionRouteOptions = {},
): void {
  const collection = new FileCollection(ctx.db);
  app.get<CollectionRoute>("/api/workspaces/:id/assets", async (request) => {
    const workspace = ctx.workspaces.mustGet(request.params.id as WorkspaceId);
    const parsed = parseFileCollectionQuery(request.query);
    if (!parsed.ok)
      throw new DeskmatesError("validation", `Invalid ${parsed.field} for the files collection`, {
        field: parsed.field,
      });
    const page = collection.list(
      workspace.id,
      parsed.query,
      opts.scanLimit === undefined ? {} : { scanLimit: opts.scanLimit },
    );
    const log: FileCollectionLog = opts.log ?? ((msg, data) => request.log.info(data, msg));
    log("workspace files listed", {
      workspaceId: workspace.id,
      actor: request.principal ? actorLabel(request.principal) : "operator",
      type: parsed.query.type,
      source: parsed.query.source,
      searched: parsed.query.q !== "",
      offset: parsed.query.offset,
      total: page.total,
      truncated: page.truncated,
    });
    return page;
  });
}
