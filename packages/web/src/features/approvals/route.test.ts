// @vitest-environment node
// T0: the attention inbox's route.

import { describeRoutes } from "../../app/testing/route-expectations.js";
import { approvalsHref, routes } from "./route.js";

describeRoutes({
  owner: "approvals",
  module: routes,
  screens: { approvals: "approvals" },
  addresses: [
    ["#/approvals", { name: "approvals" }],
    ["#/approvals/", { name: "approvals" }],
    ["#/approvals/x", { name: "approvals" }],
  ],
  hrefs: [[approvalsHref(), "#/approvals", { name: "approvals" }]],
  viewed: [["#/approvals", "approvals", "approvals", "approvals", "approvals"]],
});
