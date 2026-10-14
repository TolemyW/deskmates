// @vitest-environment node
// T0: the Skills route.

import { describeRoutes } from "../../app/testing/route-expectations.js";
import { routes, skillsHref } from "./route.js";

describeRoutes({
  owner: "skills",
  module: routes,
  screens: { skills: "workspaces" },
  addresses: [
    ["#/skills", { name: "skills" }],
    ["#/skills/x", { name: "skills" }, "#/skills"],
  ],
  hrefs: [[skillsHref(), "#/skills", { name: "skills" }]],
  viewed: [["#/skills", "skills", "workspaces", "skills", "workspaces"]],
});
