import { Users } from "lucide-react";
import { defineFeature } from "../../app/feature.js";
import { readableBy } from "../../app/routes.js";
import { ContactsScreen } from "./contacts.js";
import { contactsHref, routes } from "./route.js";

export const feature = defineFeature(routes, {
  nav: {
    group: "talk",
    order: 40,
    icon: <Users size={18} />,
    label: "app.nav.contacts",
    href: contactsHref,
    active: (route) => route.name === "contacts",
    visible: readableBy("bots.read"),
  },
  // `#/desktops` arrives here as the contacts list (the route module's `shown`).
  render: (route, { api }) => (
    <ContactsScreen
      api={api}
      botId={route.name === "desktops" ? undefined : route.id}
      creatingNew={route.name === "contacts" && route.creating === true}
    />
  ),
});
