// @vitest-environment jsdom
// T0: the Computer navigation entry and screen.

import { Monitor } from "lucide-react";
import {
  STUB_CONTEXT,
  describeNavEntry,
  describeRender,
} from "../../app/testing/feature-expectations.js";
import { ComputerScreen } from "./computer.js";
import { feature } from "./feature.js";

describeNavEntry({
  folder: "computer",
  feature,
  group: "operate",
  order: 10,
  icon: Monitor,
  label: "app.nav.computer",
  english: "Computer",
  href: "#/computer",
  currentAt: ["#/computer", "#/manage", "#/workspace/settings"],
  visibleTo: { manager: true, member: true },
});

describeRender("computer", [["#/computer", ComputerScreen, { api: STUB_CONTEXT.api }]]);
