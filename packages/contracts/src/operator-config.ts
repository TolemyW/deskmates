// What `GET /api/config` hands the operator UI: the model ids plus the running release label.

import type { ModelConfig } from "./model-config.js";

/**
 * The response of `GET /api/config`. `release` is the Gateway's `DESKMATES_RELEASE` (a release tag
 * such as `v0.2.0`), or `null` when the process was started without one, e.g. from a working
 * tree. It is a label for humans, not a version check. Like `ModelConfig`, nothing secret or
 * address-shaped may be added here.
 */
export interface OperatorConfig extends ModelConfig {
  release: string | null;
  /** Effective process time zone used by the Gateway cron runner. */
  cronTimeZone: string;
}
