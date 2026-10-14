import { Monitor } from "lucide-react";
import { defineFeature } from "../../app/feature.js";
import { readableBy } from "../../app/routes.js";
import { ComputerScreen } from "./computer.js";
import { computerHref, routes } from "./route.js";

export const feature = defineFeature(routes, {
  nav: {
    group: "operate",
    order: 10,
    icon: <Monitor size={18} />,
    label: "app.nav.computer",
    href: computerHref,
    active: (route) => route.name === "computer",
    visible: readableBy("desktops.read"),
  },
  render: (_route, { api }) => <ComputerScreen api={api} />,
});
