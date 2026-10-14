// @vitest-environment node
// T0: the People route. For a Member the address shows Chats, and so does its help.

import { describeRoutes } from "../../app/testing/route-expectations.js";
import { membersHref, routes } from "./route.js";

describeRoutes({
  owner: "members",
  module: routes,
  screens: { members: "people-and-roles" },
  addresses: [["#/members", { name: "members" }]],
  hrefs: [[membersHref(), "#/members", { name: "members" }]],
  viewed: [["#/members", "members", "people-and-roles", "threads", "chats-and-groups"]],
});
