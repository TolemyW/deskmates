// @vitest-environment jsdom
// T1 (in-process): the run drawer's Analytics link (ADR-0046 decision 8) appears when the Gateway
// reports `analyticsUrl` and the session is the root, opens the run view in a new tab, and is
// absent otherwise.

import type { OperatorConfig, SessionRoles } from "@deskmates/contracts";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { SessionRolesProvider } from "../../state/session-roles.js";
import { AnalyticsRunLink } from "./analytics-run-link.js";

afterEach(cleanup);

function api(config: Partial<OperatorConfig>) {
  let asked = 0;
  return {
    source: {
      getConfig: async () => {
        asked += 1;
        return config as OperatorConfig;
      },
    },
    asked: () => asked,
  };
}

function shown(node: ReactNode, roles?: SessionRoles) {
  return render(
    <I18nProvider locale="en">
      {roles ? <SessionRolesProvider roles={roles}>{node}</SessionRolesProvider> : node}
    </I18nProvider>,
  );
}

const ROOT: SessionRoles = { tenantRole: "owner", platformMaintainer: false, root: true };
const OWNER: SessionRoles = { tenantRole: "owner", platformMaintainer: false };

describe("AnalyticsRunLink", () => {
  it("opens the run's view in Grafana in a new tab for the root", async () => {
    const { source } = api({ analyticsUrl: "/analytics/" });
    shown(<AnalyticsRunLink api={source} runId="run_7" />, ROOT);
    const link = await screen.findByRole("link", { name: "Open in Analytics" });
    expect(link.getAttribute("href")).toBe(
      "/analytics/d/deskmates-agent-runs/agent-runs?var-run=run_7",
    );
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("title")).toBe("Open this run in Grafana, in a new tab");
  });

  it("is absent while the Gateway reports no analyticsUrl", async () => {
    const config = api({ analyticsUrl: null });
    const { container } = shown(<AnalyticsRunLink api={config.source} runId="run_7" />, ROOT);
    await waitFor(() => expect(config.asked()).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.querySelector("a")).toBeNull();
  });

  it("is absent for an Owner who is not the root", async () => {
    const config = api({ analyticsUrl: "/analytics/" });
    const { container } = shown(<AnalyticsRunLink api={config.source} runId="run_7" />, OWNER);
    await waitFor(() => expect(config.asked()).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.querySelector("a")).toBeNull();
  });
});
