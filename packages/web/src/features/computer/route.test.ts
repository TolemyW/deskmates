// @vitest-environment node
// T0: the Computer route, and the older `#/manage` address (issue #27).

import { describeRoutes } from "../../app/testing/route-expectations.js";
import { computerHref, routes } from "./route.js";

describeRoutes({
  owner: "computer",
  module: routes,
  screens: { computer: "workspaces" },
  addresses: [
    ["#/computer", { name: "computer" }],
    ["#/computer/x", { name: "computer" }, "#/computer"],
    ["#/manage", { name: "computer" }, "#/computer"],
  ],
  hrefs: [[computerHref(), "#/computer", { name: "computer" }]],
  viewed: [["#/computer", "computer", "workspaces", "computer", "workspaces"]],
});
