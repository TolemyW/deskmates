// @vitest-environment node
// T0: the Integrations route.

import { describeRoutes } from "../../app/testing/route-expectations.js";
import { integrationsHref, routes } from "./route.js";

describeRoutes({
  owner: "integrations",
  module: routes,
  screens: { integrations: "integrations-and-connectors" },
  addresses: [["#/integrations", { name: "integrations" }]],
  hrefs: [[integrationsHref(), "#/integrations", { name: "integrations" }]],
  viewed: [
    [
      "#/integrations",
      "integrations",
      "integrations-and-connectors",
      "integrations",
      "integrations-and-connectors",
    ],
  ],
});
