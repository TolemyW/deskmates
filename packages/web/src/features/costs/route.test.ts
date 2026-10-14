// @vitest-environment node
// T0: the Costs route.

import { describeRoutes } from "../../app/testing/route-expectations.js";
import { costsHref, routes } from "./route.js";

describeRoutes({
  owner: "costs",
  module: routes,
  screens: { costs: "costs" },
  addresses: [
    ["#/costs", { name: "costs" }],
    ["#/costs/x", { name: "costs" }],
  ],
  hrefs: [[costsHref(), "#/costs", { name: "costs" }]],
  viewed: [["#/costs", "costs", "costs", "costs", "costs"]],
});
