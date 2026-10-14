// @vitest-environment node
// T0: the Files route. Only `#/resources/files` opens it.

import { describeRoutes } from "../../app/testing/route-expectations.js";
import { filesHref, routes } from "./route.js";

describeRoutes({
  owner: "files",
  module: routes,
  screens: { files: "workspaces" },
  addresses: [
    ["#/files", { name: "home" }],
    ["#/resources", { name: "home" }],
    ["#/resources/files", { name: "files" }],
    ["#/resources/other", { name: "home" }],
  ],
  hrefs: [[filesHref(), "#/resources/files", { name: "files" }]],
  viewed: [["#/resources/files", "files", "workspaces", "files", "workspaces"]],
});
