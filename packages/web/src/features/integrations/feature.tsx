import { Plug } from "lucide-react";
import { defineFeature } from "../../app/feature.js";
import { readableBy } from "../../app/routes.js";
import { IntegrationsScreen } from "./integrations.js";
import { integrationsHref, routes } from "./route.js";

export const feature = defineFeature(routes, {
  nav: {
    group: "operate",
    order: 30,
    icon: <Plug size={18} />,
    label: "app.nav.integrations",
    href: integrationsHref,
    active: (route) => route.name === "integrations",
    visible: readableBy("integrations.read"),
  },
  render: (_route, { api }) => <IntegrationsScreen api={api} />,
});
