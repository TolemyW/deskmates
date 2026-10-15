// @vitest-environment node
// T0: the runs index route (issue #11). A run row opens the runs feature's drawer, not this one.

import { describeRoutes } from "../../app/testing/route-expectations.js";
import { routes, runIndexHref } from "./route.js";

describeRoutes({
  owner: "run-index",
  module: routes,
  screens: { runIndex: "chats-and-groups" },
  addresses: [
    ["#/run-index", { name: "runIndex" }],
    ["#/run-index/x", { name: "runIndex" }],
  ],
  hrefs: [[runIndexHref(), "#/run-index", { name: "runIndex" }]],
  viewed: [["#/run-index", "runIndex", "chats-and-groups", "runIndex", "chats-and-groups"]],
});
