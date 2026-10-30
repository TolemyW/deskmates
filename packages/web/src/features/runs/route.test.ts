// @vitest-environment node
// T0: the run drawer's routes. The retired run index leads to bot activity in Contacts (#20).

import type { RunId } from "@deskmates/contracts";
import { describeRoutes } from "../../app/testing/route-expectations.js";
import { routes, runHref } from "./route.js";

describeRoutes({
  owner: "runs",
  module: routes,
  screens: { runs: "chats-and-groups" },
  addresses: [
    ["#/runs", { name: "contacts" }, "#/contacts"],
    ["#/runs/", { name: "contacts" }, "#/contacts"],
    ["#/runs/run_1", { name: "runs", id: "run_1" as RunId }],
    ["#/runs/a%2Fb", { name: "runs", id: "a/b" as RunId }],
  ],
  hrefs: [[runHref("r/1"), "#/runs/r%2F1", { name: "runs", id: "r/1" as RunId }]],
  viewed: [["#/runs/run_1", "runs", "chats-and-groups", "runs", "chats-and-groups"]],
});
