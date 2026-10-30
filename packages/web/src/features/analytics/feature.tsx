// Analytics: a navigation entry that opens Grafana in a new tab (ADR-0046 decision 8). Shown to
// the root only, matching `GET /api/observability/status`, and only while the Gateway reports an
// `analyticsUrl`.

import { ChartSpline } from "lucide-react";
import { defineFeature } from "../../app/feature.js";
import { readableBy } from "../../app/routes.js";
import { useAnalyticsUrl } from "./analytics-url.js";
import { routes } from "./route.js";

export const feature = defineFeature(routes, {
  nav: {
    group: "operate",
    audience: "tune",
    order: 25,
    icon: <ChartSpline size={18} />,
    label: "app.nav.analytics",
    external: { useHref: ({ api }) => useAnalyticsUrl(api) },
    visible: readableBy("observability.read"),
  },
  render: () => null,
});
