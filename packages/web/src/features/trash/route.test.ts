// @vitest-environment node
// T0: the workspace trash route.

import { describeRoutes } from "../../app/testing/route-expectations.js";
import { routes, trashHref } from "./route.js";

describeRoutes({
  owner: "trash",
  module: routes,
  screens: { trash: "workspaces" },
  addresses: [
    ["#/trash", { name: "trash" }],
    ["#/trash/x", { name: "trash" }],
  ],
  hrefs: [[trashHref(), "#/trash", { name: "trash" }]],
  viewed: [["#/trash", "trash", "workspaces", "trash", "workspaces"]],
});
