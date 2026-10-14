// @vitest-environment node
// T0: the Knowledge routes, and the older Shared computer and Memory addresses (issue #27).

import { describeRoutes } from "../../app/testing/route-expectations.js";
import { knowledgeHref, routes } from "./route.js";

describeRoutes({
  owner: "knowledge",
  module: routes,
  screens: { knowledge: "workspaces" },
  addresses: [
    ["#/knowledge", { name: "knowledge", tab: "documents" }, "#/knowledge/documents"],
    ["#/knowledge/", { name: "knowledge", tab: "documents" }, "#/knowledge/documents"],
    ["#/knowledge/documents", { name: "knowledge", tab: "documents" }],
    ["#/knowledge/observations", { name: "knowledge", tab: "observations" }],
    ["#/knowledge/nope", { name: "knowledge", tab: "documents" }, "#/knowledge/documents"],
    ["#knowledge/documents", { name: "knowledge", tab: "documents" }],
    ["#/workspace", { name: "knowledge", tab: "documents" }, "#/knowledge/documents"],
    ["#/workspace/library", { name: "knowledge", tab: "documents" }, "#/knowledge/documents"],
    ["#/workspace/unknown", { name: "knowledge", tab: "documents" }, "#/knowledge/documents"],
    ["#/workspace/facts", { name: "knowledge", tab: "observations" }, "#/knowledge/observations"],
    // The former page's Settings tab moved to Computer.
    ["#/workspace/settings", { name: "computer" }, "#/computer"],
    ["#/workspace/se%74tings", { name: "computer" }, "#/computer"],
    ["#/memory", { name: "knowledge", tab: "observations" }, "#/knowledge/observations"],
    ["#/memory/x", { name: "knowledge", tab: "observations" }, "#/knowledge/observations"],
  ],
  hrefs: [
    [knowledgeHref(), "#/knowledge/documents", { name: "knowledge", tab: "documents" }],
    [
      knowledgeHref("observations"),
      "#/knowledge/observations",
      { name: "knowledge", tab: "observations" },
    ],
  ],
  viewed: [["#/knowledge/observations", "knowledge", "workspaces", "knowledge", "workspaces"]],
});
