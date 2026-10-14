// @vitest-environment node
// T0: the shell's invitation route. It is not a signed-in screen, so Help treats it as home.

import { routes } from "./invite-route.js";
import { describeRoutes } from "./testing/route-expectations.js";

describeRoutes({
  owner: "app",
  module: routes,
  screens: { invite: null },
  addresses: [
    ["#/invite", { name: "home" }],
    ["#/invite/", { name: "home" }],
    ["#/invite/tok_1", { name: "invite", token: "tok_1" }],
    ["#/invite/a%2Bb", { name: "invite", token: "a+b" }],
  ],
  hrefs: [],
  viewed: [["#/invite/tok", "home", "getting-started", "home", "getting-started"]],
});
