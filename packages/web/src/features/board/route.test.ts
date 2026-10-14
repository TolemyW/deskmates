// @vitest-environment node
// T0: the board route.

import { describeRoutes } from "../../app/testing/route-expectations.js";
import { boardHref, routes } from "./route.js";

describeRoutes({
  owner: "board",
  module: routes,
  screens: { board: "workspaces" },
  addresses: [
    ["#/board", { name: "board" }],
    ["#/board/x", { name: "board" }],
  ],
  hrefs: [[boardHref(), "#/board", { name: "board" }]],
  viewed: [["#/board", "board", "workspaces", "board", "workspaces"]],
});
