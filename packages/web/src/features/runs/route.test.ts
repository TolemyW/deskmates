// @vitest-environment node
// T0: the run drawer's routes. A run address needs an id; without one it lands on home.

import { describeRoutes } from "../../app/testing/route-expectations.js";
import { routes, runHref } from "./route.js";

describeRoutes({
  owner: "runs",
  module: routes,
  screens: { runs: "chats-and-groups" },
  addresses: [
    ["#/runs", { name: "home" }],
    ["#/runs/", { name: "home" }],
    ["#/runs/run_1", { name: "runs", id: "run_1" }],
    ["#/runs/a%2Fb", { name: "runs", id: "a/b" }],
  ],
  hrefs: [[runHref("r/1"), "#/runs/r%2F1", { name: "runs", id: "r/1" }]],
  viewed: [["#/runs/run_1", "runs", "chats-and-groups", "runs", "chats-and-groups"]],
});
