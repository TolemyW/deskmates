// @vitest-environment jsdom
// T0: the Analytics navigation entry (ADR-0046 decision 8): an external link in Operate, after
// Costs, shown to the root only, owning no route. How the shell draws it is in
// app/navigation.test.tsx.

import { mayTakeAction } from "@deskmates/contracts";
import { ChartSpline } from "lucide-react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { FEATURES } from "../../app/features.js";
import { ENGLISH } from "../../i18n/catalogs.js";
import { feature } from "./feature.js";
import { routes } from "./route.js";

describe("analytics navigation entry", () => {
  const nav = feature.nav;

  it("is registered under its folder and owns no route", () => {
    expect(FEATURES.get("analytics")).toBe(feature);
    expect(routes.screens).toEqual({});
    expect(routes.segments).toEqual({});
  });

  it("sits in Operate after Costs, with its icon and label, and leaves the app", () => {
    expect(nav?.group).toBe("operate");
    expect(nav?.order).toBe(25);
    const icon = nav?.icon as ReactElement<{ size?: number }>;
    expect(icon.type).toBe(ChartSpline);
    expect(icon.props.size).toBe(18);
    expect(nav?.label).toBe("app.nav.analytics");
    expect(ENGLISH["app.nav.analytics"]).toBe("Analytics");
    expect(nav?.external?.useHref).toBeTypeOf("function");
    expect(nav?.href).toBeUndefined();
  });

  it("shows to the root alone, like GET /api/observability/status", () => {
    const visible = (roles: Parameters<typeof mayTakeAction>[0]) =>
      nav?.visible?.({ manager: true, can: (action) => mayTakeAction(roles, action) });
    expect(visible({ tenantRole: "owner", platformMaintainer: false, root: true })).toBe(true);
    for (const tenantRole of ["owner", "admin", "member", "guest"] as const)
      expect(visible({ tenantRole, platformMaintainer: false }), tenantRole).toBe(false);
    expect(visible({ tenantRole: "owner", platformMaintainer: true })).toBe(false);
  });
});
