// `GET /api/observability/status` (ADR-0046 decision 8, root only): the pipeline's state, so an
// operator can tell a collector that is behind or failing from one with nothing to report. With
// `OBSERVABILITY_SINK` unset it answers `enabled: false`; it never starts or changes anything.

import type { ObservabilityStatus } from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import type { GatewayContext } from "../context.js";
import { observabilityOf } from "../observability/observability-module.js";

export function registerObservabilityRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  app.get("/api/observability/status", async (): Promise<ObservabilityStatus> => {
    const module = observabilityOf(ctx);
    if (module) return module.status();
    return {
      enabled: false,
      grafanaUrl: ctx.config.observabilityGrafanaUrl ?? null,
      sink: null,
      payloads: null,
      batchSeconds: null,
      batchBytes: null,
      retentionDays: null,
      tables: [],
      newestBatch: null,
      openBatch: null,
      pendingBatches: 0,
      spoolBytes: 0,
      sinkStats: null,
      lastError: null,
    };
  });
}
