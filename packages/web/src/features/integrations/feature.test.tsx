// @vitest-environment jsdom
// T0: the Connections navigation entry (Resources, everyday view) and screen.

import { Plug } from "lucide-react";
import { expect, it } from "vitest";
import {
  STUB_CONTEXT,
  describeNavEntry,
  describeRender,
} from "../../app/testing/feature-expectations.js";
import { ConnectionsScreen } from "./connections.js";
import { feature } from "./feature.js";

describeNavEntry({
  folder: "integrations",
  feature,
  group: "resources",
  order: 15,
  icon: Plug,
  label: "app.nav.connections",
  english: "Connections",
  href: "#/connections/channels",
  currentAt: ["#/connections", "#/connections/apps", "#/integrations"],
  visibleTo: { manager: true, member: true },
});

describeRender("integrations", [
  ["#/connections/channels", ConnectionsScreen, { api: STUB_CONTEXT.api, tab: "channels" }],
  ["#/integrations", ConnectionsScreen, { api: STUB_CONTEXT.api, tab: "apps" }],
]);

it("is in the everyday view, not only in Tune", () => {
  expect(feature.nav?.audience).toBeUndefined();
});
