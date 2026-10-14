// @vitest-environment jsdom
// T0: the Skills navigation entry and screen.

import { Puzzle } from "lucide-react";
import {
  STUB_CONTEXT,
  describeNavEntry,
  describeRender,
} from "../../app/testing/feature-expectations.js";
import { feature } from "./feature.js";
import { SkillsScreen } from "./skills.js";

describeNavEntry({
  folder: "skills",
  feature,
  group: "resources",
  order: 30,
  icon: Puzzle,
  label: "app.nav.skills",
  english: "Skills",
  href: "#/skills",
  currentAt: ["#/skills"],
  visibleTo: { manager: true, member: true },
});

describeRender("skills", [["#/skills", SkillsScreen, { api: STUB_CONTEXT.api }]]);
