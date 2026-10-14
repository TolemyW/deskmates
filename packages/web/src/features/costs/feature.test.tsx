// @vitest-environment jsdom
// T0: the Costs navigation entry and screen.

import { ChartNoAxesCombined } from "lucide-react";
import {
  STUB_CONTEXT,
  describeNavEntry,
  describeRender,
} from "../../app/testing/feature-expectations.js";
import { CostsScreen } from "./costs.js";
import { feature } from "./feature.js";

describeNavEntry({
  folder: "costs",
  feature,
  group: "operate",
  order: 20,
  icon: ChartNoAxesCombined,
  label: "app.nav.costs",
  english: "Costs",
  href: "#/costs",
  currentAt: ["#/costs"],
  visibleTo: { manager: true, member: true },
});

describeRender("costs", [["#/costs", CostsScreen, { api: STUB_CONTEXT.api }]]);
