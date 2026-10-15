// @vitest-environment jsdom
// T0: the runs index navigation entry and screen (issue #11, ADR-0042).

import { ListChecks } from "lucide-react";
import {
  STUB_CONTEXT,
  describeNavEntry,
  describeRender,
} from "../../app/testing/feature-expectations.js";
import { feature } from "./feature.js";
import { RunIndexScreen } from "./run-index.js";

describeNavEntry({
  folder: "run-index",
  feature,
  group: "operate",
  order: 25,
  icon: ListChecks,
  label: "runIndex.nav",
  english: "Runs",
  href: "#/run-index",
  currentAt: ["#/run-index"],
  visibleTo: { manager: true, member: true },
});

describeRender("run-index", [["#/run-index", RunIndexScreen, { api: STUB_CONTEXT.api }]]);
