// What a run records about where its models are served (ADR-0039 decision 4). At start the run's
// `config_json` gains `modelUpstreams`, the upstream id of each frozen model (`null` when none
// serves it), so a result can be attributed to an upstream after the registry changes. Routing
// itself reads the registry in force; this record is attribution, not a routing input.

import type { GatewayConfig } from "../config.js";
import { modelRegistryOf } from "../config/model-upstreams.js";

export function modelUpstreamsOf(
  ctx: { config: GatewayConfig },
  models: readonly (string | undefined)[],
): Record<string, string | null> {
  const registry = modelRegistryOf(ctx.config);
  const out: Record<string, string | null> = {};
  for (const model of models) {
    if (model === undefined || model === "" || model in out) continue;
    out[model] = registry.upstreamOf(model) ?? null;
  }
  return out;
}
