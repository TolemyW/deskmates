// @vitest-environment node
// T0: the contacts routes, and the older `#/channels` and `#/desktops` addresses.

import { describeRoutes } from "../../app/testing/route-expectations.js";
import { channelHref, contactHref, contactsHref, newContactHref, routes } from "./route.js";

describeRoutes({
  owner: "contacts",
  module: routes,
  screens: { contacts: "bots", channels: "channels", desktops: "workspaces" },
  addresses: [
    ["#/contacts", { name: "contacts" }],
    ["#/contacts/", { name: "contacts" }, "#/contacts"],
    ["#/contacts/new", { name: "contacts", creating: true }],
    ["#/contacts/bot_1", { name: "contacts", id: "bot_1" }],
    ["#/contacts/a%2Fb", { name: "contacts", id: "a/b" }],
    ["#/channels", { name: "channels" }],
    ["#/channels/bot_1", { name: "channels", id: "bot_1" }],
    ["#/desktops", { name: "desktops" }],
    ["#/desktops/bot_1", { name: "desktops" }],
  ],
  hrefs: [
    [contactsHref(), "#/contacts", { name: "contacts" }],
    [contactHref("b/1"), "#/contacts/b%2F1", { name: "contacts", id: "b/1" }],
    [newContactHref(), "#/contacts/new", { name: "contacts", creating: true }],
    [channelHref("b/1"), "#/channels/b%2F1", { name: "channels", id: "b/1" }],
  ],
  viewed: [
    ["#/contacts/new", "contacts", "bots", "contacts", "bots"],
    ["#/channels", "channels", "channels", "channels", "channels"],
    // `#/desktops` renders the contacts list, so its help is the bots page.
    ["#/desktops", "contacts", "bots", "contacts", "bots"],
  ],
});
