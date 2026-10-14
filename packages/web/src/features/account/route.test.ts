// @vitest-environment node
// T0: the User Settings routes (ADR-0034 decision 7): Personal settings, Agent access and
// Workspaces with its search, filters and detail in the address.

import { describeRoutes } from "../../app/testing/route-expectations.js";
import {
  accountHref,
  agentAccessHref,
  routes,
  workspaceDetailHref,
  workspacesHref,
} from "./route.js";

describeRoutes({
  owner: "account",
  module: routes,
  screens: { account: "people-and-roles" },
  addresses: [
    ["#/account", { name: "account" }],
    ["#/account/agent-access", { name: "account", page: "agent-access" }],
    ["#/account/workspaces", { name: "account", page: "workspaces", list: {} }],
    [
      "#/account/workspaces?q=ops&filter=archived&role=admin",
      {
        name: "account",
        page: "workspaces",
        list: { q: "ops", filter: "archived", role: "admin" },
      },
    ],
    [
      "#/account/workspaces?filter=bogus&role=root&ws=ws_1",
      { name: "account", page: "workspaces", list: {}, workspaceId: "ws_1" },
    ],
    ["#/account/unknown", { name: "account" }],
  ],
  hrefs: [
    [accountHref(), "#/account", { name: "account" }],
    [agentAccessHref(), "#/account/agent-access", { name: "account", page: "agent-access" }],
    [
      workspacesHref({ q: "研究", filter: "pinned" }),
      `#/account/workspaces?q=${encodeURIComponent("研究")}&filter=pinned`,
      { name: "account", page: "workspaces", list: { q: "研究", filter: "pinned" } },
    ],
    [
      workspaceDetailHref("ws_9", { role: "guest" }),
      "#/account/workspaces?role=guest&ws=ws_9",
      { name: "account", page: "workspaces", list: { role: "guest" }, workspaceId: "ws_9" },
    ],
  ],
  viewed: [["#/account", "account", "people-and-roles", "account", "people-and-roles"]],
});
