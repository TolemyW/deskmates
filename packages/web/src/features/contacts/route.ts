// Contacts: `#/contacts[/new|/<bot id>]`, and two older addresses that still render the contacts
// screen: `#/channels[/<bot id>]` and `#/desktops`.

import { defineRoutes } from "../../app/routes.js";

declare module "../../app/routes.js" {
  interface RouteMap {
    contacts: { name: "contacts"; id?: string; creating?: boolean };
    channels: { name: "channels"; id?: string };
    desktops: { name: "desktops" };
  }
}

/** The contacts list. */
export function contactsHref(): string {
  return "#/contacts";
}

export function contactHref(botId: string): string {
  return `#/contacts/${encodeURIComponent(botId)}`;
}

export function newContactHref(): string {
  return "#/contacts/new";
}

export function channelHref(botId: string): string {
  return `#/channels/${encodeURIComponent(botId)}`;
}

export const routes = defineRoutes({
  screens: { contacts: "bots", channels: "channels", desktops: "workspaces" },
  segments: {
    contacts: (rest) => {
      if (rest === "new") return { name: "contacts", creating: true };
      return rest ? { name: "contacts", id: decodeURIComponent(rest) } : { name: "contacts" };
    },
    channels: (rest) =>
      rest ? { name: "channels", id: decodeURIComponent(rest) } : { name: "channels" },
    desktops: () => ({ name: "desktops" }),
  },
  // The legacy `#/desktops` path renders the contacts list.
  shown: (route) => (route.name === "desktops" ? { name: "contacts" } : route),
});
