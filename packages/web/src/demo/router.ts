// Routes one operator request through the demo features: the first feature whose handler claims
// it answers, and a request nobody claims gets the demo's 404.

import type { DemoFeature, DemoRequest } from "./feature.js";
import type { Result } from "./result.js";
import type { DemoState } from "./state.js";

export function demoRequest(method: string, fullPath: string, body: unknown): DemoRequest {
  const url = new URL(fullPath, "http://mock");
  const path = url.pathname;
  return {
    method,
    path,
    query: url.searchParams,
    body: (body ?? {}) as Record<string, unknown>,
    match: (re) => path.match(re),
  };
}

export async function routeDemoRequest(
  features: readonly DemoFeature[],
  state: DemoState,
  method: string,
  fullPath: string,
  body: unknown,
): Promise<Result> {
  const req = demoRequest(method, fullPath, body);
  for (const feature of features) {
    const result = feature.route?.(req, state);
    if (result !== undefined) return result;
  }
  return {
    status: 404,
    json: {
      code: "not_found",
      message: `The demo Gateway has no route for ${method} ${req.path}.`,
      details: {},
    },
  };
}
