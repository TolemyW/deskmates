// Where Analytics is (ADR-0046 decision 8, amendment 1 decision 16): `analyticsUrl` of
// `GET /api/config`, the Gateway's same-origin relay to Grafana (`/analytics/`), or null when
// `OBSERVABILITY_GRAFANA_URL` is not set, which hides the Analytics entry and the run drawer's
// link. One request per API client; a failed one is asked again on the next mount.

import { useEffect, useState } from "react";
import type { ApiClient } from "../../api/client.js";

export type ConfigSource = Pick<ApiClient, "getConfig">;

/**
 * The run view: the agent runs dashboard of packages/observability-dashboards with its `run`
 * variable set. `analytics-url.test.ts` checks these against the committed dashboard.
 */
export const RUN_VIEW = {
  uid: "deskmates-agent-runs",
  slug: "agent-runs",
  variable: "run",
} as const;

const loaded = new WeakMap<ConfigSource, Promise<string | null>>();

export function loadAnalyticsUrl(api: ConfigSource): Promise<string | null> {
  let url = loaded.get(api);
  if (url === undefined) {
    url = api.getConfig().then(
      (config) => config.analyticsUrl ?? null,
      () => {
        loaded.delete(api);
        return null;
      },
    );
    loaded.set(api, url);
  }
  return url;
}

/** The Analytics address, or null until it is known and when it is not set. */
export function useAnalyticsUrl(api: ConfigSource): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void loadAnalyticsUrl(api).then((value) => {
      if (live) setUrl(value);
    });
    return () => {
      live = false;
    };
  }, [api]);
  return url;
}

/** One run in Grafana's run view, under the Analytics address (a path on this origin). */
export function analyticsRunHref(analyticsUrl: string, runId: string): string {
  const base = analyticsUrl.endsWith("/") ? analyticsUrl : `${analyticsUrl}/`;
  const query = new URLSearchParams({ [`var-${RUN_VIEW.variable}`]: runId });
  return `${base}d/${RUN_VIEW.uid}/${RUN_VIEW.slug}?${query.toString()}`;
}
