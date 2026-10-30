// @vitest-environment node
// T0: the Vault route (ADR-0045).

import { describeRoutes } from "../../app/testing/route-expectations.js";
import { routes, vaultHref } from "./route.js";

describeRoutes({
  owner: "vault",
  module: routes,
  screens: { vault: "integrations-and-connectors" },
  addresses: [
    ["#/vault", { name: "vault" }],
    ["#/vault/x", { name: "vault" }],
  ],
  hrefs: [[vaultHref(), "#/vault", { name: "vault" }]],
  viewed: [
    ["#/vault", "vault", "integrations-and-connectors", "vault", "integrations-and-connectors"],
  ],
});
