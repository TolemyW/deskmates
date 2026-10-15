// Network profiles: a navigation link for the administrator account only (ADR-0027 amendment 1
// decision 12); anyone else who opens `#/network` lands on Chats, like any link they do not see.

import { Network } from "lucide-react";
import { defineFeature } from "../../app/feature.js";
import { readableBy } from "../../app/routes.js";
import { NetworkScreen } from "./network.js";
import { networkHref, routes } from "./route.js";

export const feature = defineFeature(routes, {
  nav: {
    group: "operate",
    order: 50,
    icon: <Network size={18} />,
    label: "network.nav",
    href: networkHref,
    active: (route) => route.name === "network",
    visible: readableBy("network.read"),
  },
  render: (_route, { api }) => <NetworkScreen api={api} />,
});
