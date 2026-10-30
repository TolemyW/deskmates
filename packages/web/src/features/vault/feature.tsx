// The Vault: a navigation link for every Member of the selected workspace, who reads the catalog;
// an Owner or Admin maintains it (ADR-0045 decision 2).

import { KeyRound } from "lucide-react";
import { defineFeature } from "../../app/feature.js";
import { readableBy } from "../../app/routes.js";
import { routes, vaultHref } from "./route.js";
import { VaultScreen } from "./vault.js";

export const feature = defineFeature(routes, {
  nav: {
    group: "operate",
    audience: "tune",
    order: 35,
    icon: <KeyRound size={18} />,
    label: "vault.nav",
    href: vaultHref,
    active: (route) => route.name === "vault",
    visible: readableBy("vault.read"),
  },
  render: (_route, { api }) => <VaultScreen api={api} />,
});
