// What `GET /api/config` hands the operator UI: the model ids, the running release label and the
// Analytics link.

import type { ModelConfig, RegisteredModel } from "./model-config.js";

/**
 * The response of `GET /api/config`. `release` is the Gateway's `DESKMATES_RELEASE` (a release tag
 * such as `v0.2.0`), or `null` when the process was started without one, e.g. from a working
 * tree. It is a label for humans, not a version check. Like `ModelConfig`, nothing secret or
 * address-shaped may be added here; `analyticsUrl` is a path on the Gateway's own origin.
 */
export interface OperatorConfig extends ModelConfig {
  release: string | null;
  /** Effective process time zone used by the Gateway cron runner. */
  cronTimeZone: string;
  /**
   * Models the registry names (ADR-0039 decision 8), with the id of the upstream serving each,
   * sorted by model id. Upstream ids only; addresses and tokens never leave the Gateway.
   */
  models: RegisteredModel[];
  /**
   * `/analytics/`, the Gateway's relay to Grafana, when `OBSERVABILITY_GRAFANA_URL` is set
   * (ADR-0046 decision 8, amendment 1 decision 16): where the Analytics entry and the run drawer's
   * run link go; null hides both. Grafana's own address never leaves the Gateway here.
   */
  analyticsUrl: string | null;
}
