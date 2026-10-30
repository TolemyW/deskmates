// @vitest-environment node
// T0: the Connections route, and the former Integrations address that opens its Apps tab.

import { describeRoutes } from "../../app/testing/route-expectations.js";
import { connectionsHref, routes } from "./route.js";

describeRoutes({
  owner: "integrations",
  module: routes,
  screens: { connections: "integrations-and-connectors" },
  addresses: [
    ["#/connections", { name: "connections", tab: "channels" }, "#/connections/channels"],
    ["#/connections/apps", { name: "connections", tab: "apps" }],
    ["#/connections/databases", { name: "connections", tab: "databases" }],
    ["#/connections/unknown", { name: "connections", tab: "channels" }, "#/connections/channels"],
    ["#/integrations", { name: "connections", tab: "apps" }, "#/connections/apps"],
  ],
  hrefs: [
    [connectionsHref(), "#/connections/channels", { name: "connections", tab: "channels" }],
    [connectionsHref("apps"), "#/connections/apps", { name: "connections", tab: "apps" }],
  ],
  viewed: [
    [
      "#/integrations",
      "connections",
      "integrations-and-connectors",
      "connections",
      "integrations-and-connectors",
    ],
  ],
});
