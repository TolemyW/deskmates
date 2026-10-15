// @vitest-environment node
// T0: the published-app entry route (ADR-0035 decision 3). The app origin's sign-in hint builds
// the same address (`gateway/src/app-shares/app-share-ingress.ts`).

import { describeRoutes } from "../../app/testing/route-expectations.js";
import { appOpenHref, routes } from "./route.js";

const route = { name: "appOpen" as const, workspaceId: "ws_1", shareId: "app_1" };

describeRoutes({
  owner: "app-shares",
  module: routes,
  screens: { appOpen: "workspaces" },
  addresses: [
    ["#/apps/app_1?ws=ws_1", route],
    ["#/apps/app_1?ws=ws_1&path=%2Ftodos%2F7", { ...route, path: "/todos/7" }],
    // Only a path on the app itself lands anywhere but its start page.
    ["#/apps/app_1?ws=ws_1&path=https%3A%2F%2Fevil.example", route],
    ["#/apps/app_1?ws=ws_1&path=%2F%2Fevil.example", route],
    ["#/apps/app_1", { name: "home" }],
  ],
  hrefs: [
    [appOpenHref("ws_1", "app_1"), "#/apps/app_1?ws=ws_1", route],
    [
      appOpenHref("ws_1", "app_1", "/todos/7"),
      "#/apps/app_1?ws=ws_1&path=%2Ftodos%2F7",
      { ...route, path: "/todos/7" },
    ],
  ],
  viewed: [["#/apps/app_1?ws=ws_1", "appOpen", "workspaces", "appOpen", "workspaces"]],
});
