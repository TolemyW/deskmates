import { Plug } from "lucide-react";
import { defineFeature } from "../../app/feature.js";
import { readableBy } from "../../app/routes.js";
import { ConnectionsScreen } from "./connections.js";
import { connectionsHref, routes } from "./route.js";

export const feature = defineFeature(routes, {
  nav: {
    // Set up once, then used through chats and bots: a resource, not the daily work loop.
    group: "resources",
    order: 15,
    icon: <Plug size={18} />,
    label: "app.nav.connections",
    href: () => connectionsHref(),
    active: (route) => route.name === "connections",
    visible: readableBy("integrations.read"),
  },
  render: (route, { api, openGuide }) => (
    <ConnectionsScreen
      api={api}
      tab={route.tab}
      onOpenGuide={(anchor) => openGuide("channels", anchor)}
    />
  ),
});
