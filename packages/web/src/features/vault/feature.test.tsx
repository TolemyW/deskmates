// @vitest-environment jsdom
// T0: the Vault navigation entry shows to every Member of the selected workspace (ADR-0045
// decision 2), and the screen renders.

import { KeyRound } from "lucide-react";
import {
  STUB_CONTEXT,
  describeNavEntry,
  describeRender,
} from "../../app/testing/feature-expectations.js";
import { feature } from "./feature.js";
import { VaultScreen } from "./vault.js";

describeNavEntry({
  folder: "vault",
  feature,
  group: "operate",
  order: 35,
  icon: KeyRound,
  label: "vault.nav",
  english: "Vault",
  href: "#/vault",
  currentAt: ["#/vault"],
  visibleTo: { manager: true, member: true },
});

describeRender("vault", [["#/vault", VaultScreen, { api: STUB_CONTEXT.api }]]);
