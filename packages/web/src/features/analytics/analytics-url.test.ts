// @vitest-environment node
// T0: where Analytics and a run's view are (ADR-0046 decision 8, amendment 1 decision 16). The run view names the agent
// runs dashboard that packages/observability-dashboards generates; the committed dashboard is
// read as a file (the web imports no other package) so a renamed uid, slug or variable fails here.

import { readFileSync } from "node:fs";
import type { OperatorConfig } from "@deskmates/contracts";
import { describe, expect, it, vi } from "vitest";
import { RUN_VIEW, analyticsRunHref, loadAnalyticsUrl } from "./analytics-url.js";

const DASHBOARD = new URL(
  `../../../../../observability/grafana/sqlite/dashboards/${RUN_VIEW.slug}.json`,
  import.meta.url,
);

function source(answer: () => Promise<Partial<OperatorConfig>>) {
  return { getConfig: vi.fn(answer as () => Promise<OperatorConfig>) };
}

describe("analytics address", () => {
  it("links a run to the run view under the same-origin relay", () => {
    expect(analyticsRunHref("/analytics/", "run_01")).toBe(
      "/analytics/d/deskmates-agent-runs/agent-runs?var-run=run_01",
    );
    expect(analyticsRunHref("/analytics", "run a&b")).toBe(
      "/analytics/d/deskmates-agent-runs/agent-runs?var-run=run+a%26b",
    );
  });

  it("names a dashboard, and a variable, that the generated provisioning has", () => {
    const dashboard = JSON.parse(readFileSync(DASHBOARD, "utf8")) as {
      uid: string;
      templating: { list: { name: string; type: string }[] };
    };
    expect(dashboard.uid).toBe(RUN_VIEW.uid);
    expect(dashboard.templating.list).toContainEqual(
      expect.objectContaining({ name: RUN_VIEW.variable, type: "textbox" }),
    );
  });

  it("asks the Gateway once per client, null when it reports none", async () => {
    const configured = source(async () => ({ analyticsUrl: "/analytics/" }));
    expect(await loadAnalyticsUrl(configured)).toBe("/analytics/");
    expect(await loadAnalyticsUrl(configured)).toBe("/analytics/");
    expect(configured.getConfig).toHaveBeenCalledTimes(1);
    expect(await loadAnalyticsUrl(source(async () => ({ analyticsUrl: null })))).toBeNull();
    expect(await loadAnalyticsUrl(source(async () => ({})))).toBeNull();
  });

  it("asks again after a failed request instead of keeping its null", async () => {
    let fail = true;
    const flaky = source(async () => {
      if (fail) throw new Error("offline");
      return { analyticsUrl: "/analytics/" };
    });
    expect(await loadAnalyticsUrl(flaky)).toBeNull();
    fail = false;
    expect(await loadAnalyticsUrl(flaky)).toBe("/analytics/");
    expect(flaky.getConfig).toHaveBeenCalledTimes(2);
  });
});
