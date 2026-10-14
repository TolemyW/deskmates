// @vitest-environment jsdom
// T0: the Integrations navigation entry and screen.

import { Plug } from "lucide-react";
import {
  STUB_CONTEXT,
  describeNavEntry,
  describeRender,
} from "../../app/testing/feature-expectations.js";
import { feature } from "./feature.js";
import { IntegrationsScreen } from "./integrations.js";

describeNavEntry({
  folder: "integrations",
  feature,
  group: "operate",
  order: 30,
  icon: Plug,
  label: "app.nav.integrations",
  english: "Integrations",
  href: "#/integrations",
  currentAt: ["#/integrations"],
  visibleTo: { manager: true, member: true },
});

describeRender("integrations", [["#/integrations", IntegrationsScreen, { api: STUB_CONTEXT.api }]]);
