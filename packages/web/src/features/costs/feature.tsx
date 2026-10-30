import { ChartNoAxesCombined } from "lucide-react";
import { defineFeature } from "../../app/feature.js";
import { readableBy } from "../../app/routes.js";
import { CostsScreen } from "./costs.js";
import { costsHref, routes } from "./route.js";

export const feature = defineFeature(routes, {
  nav: {
    group: "operate",
    audience: "tune",
    order: 20,
    icon: <ChartNoAxesCombined size={18} />,
    label: "app.nav.costs",
    href: costsHref,
    active: (route) => route.name === "costs",
    visible: readableBy("costs.read"),
  },
  render: (_route, { api }) => <CostsScreen api={api} />,
});
