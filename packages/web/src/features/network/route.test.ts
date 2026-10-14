// @vitest-environment node
// T0: the network profiles route.

import { describeRoutes } from "../../app/testing/route-expectations.js";
import { networkHref, routes } from "./route.js";

describeRoutes({
  owner: "network",
  module: routes,
  screens: { network: "workspaces" },
  addresses: [
    ["#/network", { name: "network" }],
    ["#/network/x", { name: "network" }],
  ],
  hrefs: [[networkHref(), "#/network", { name: "network" }]],
  viewed: [["#/network", "network", "workspaces", "network", "workspaces"]],
});
