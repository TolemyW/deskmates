// @vitest-environment jsdom
// T0: the Contacts navigation entry, and the contacts screen for its current and older addresses.

import { Users } from "lucide-react";
import {
  STUB_CONTEXT,
  describeNavEntry,
  describeRender,
} from "../../app/testing/feature-expectations.js";
import { ContactsScreen } from "./contacts.js";
import { feature } from "./feature.js";

describeNavEntry({
  folder: "contacts",
  feature,
  group: "talk",
  order: 40,
  icon: Users,
  label: "app.nav.contacts",
  english: "Bots",
  href: "#/contacts",
  currentAt: ["#/contacts", "#/contacts/new"],
  // The older addresses render the contacts screen without marking Contacts current.
  noneCurrentAt: ["#/channels/bot_1", "#/desktops"],
  visibleTo: { manager: true, member: true },
});

const api = STUB_CONTEXT.api;
describeRender("contacts", [
  ["#/contacts", ContactsScreen, { api, botId: undefined, creatingNew: false }],
  ["#/contacts/new", ContactsScreen, { api, botId: undefined, creatingNew: true }],
  ["#/contacts/bot_1", ContactsScreen, { api, botId: "bot_1", creatingNew: false }],
  ["#/channels/bot_1", ContactsScreen, { api, botId: "bot_1", creatingNew: false }],
  ["#/desktops", ContactsScreen, { api, botId: undefined, creatingNew: false }],
]);
