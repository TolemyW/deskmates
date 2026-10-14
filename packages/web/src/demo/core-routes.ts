// Routes that belong to no feature: the operator configuration every screen reads.

import type { DemoFeature } from "./feature.js";
import { ok } from "./result.js";

export const coreDemo: DemoFeature = {
  route: (req, s) => (req.path === "/api/config" ? ok(s.config()) : undefined),
};
