// @vitest-environment jsdom
// T0: the Board navigation entry, which every role sees, and its screen.

import { Megaphone } from "lucide-react";
import {
  STUB_CONTEXT,
  describeNavEntry,
  describeRender,
} from "../../app/testing/feature-expectations.js";
import { BoardScreen } from "./board.js";
import { feature } from "./feature.js";

describeNavEntry({
  folder: "board",
  feature,
  group: "talk",
  order: 50,
  icon: Megaphone,
  label: "board.nav",
  english: "Board",
  href: "#/board",
  currentAt: ["#/board"],
  visibleTo: { manager: true, member: true },
});

describeRender("board", [["#/board", BoardScreen, { api: STUB_CONTEXT.api }]]);
describeRender("board", [["#/board", BoardScreen, { api: STUB_CONTEXT.api }]], false);
