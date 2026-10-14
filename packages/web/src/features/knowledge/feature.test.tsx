// @vitest-environment jsdom
// T0: the Knowledge navigation entry and page, on either tab and from older addresses.

import { BookOpen } from "lucide-react";
import {
  STUB_CONTEXT,
  describeNavEntry,
  describeRender,
} from "../../app/testing/feature-expectations.js";
import { feature } from "./feature.js";
import { KnowledgePage } from "./knowledge-page.js";

describeNavEntry({
  folder: "knowledge",
  feature,
  group: "resources",
  order: 20,
  icon: BookOpen,
  label: "app.nav.knowledge",
  english: "Knowledge",
  href: "#/knowledge/documents",
  currentAt: ["#/knowledge/documents", "#/knowledge/observations", "#/workspace/facts"],
  visibleTo: { manager: true, member: true },
});

const api = STUB_CONTEXT.api;
describeRender("knowledge", [
  ["#/knowledge/documents", KnowledgePage, { api, tab: "documents" }],
  ["#/knowledge/observations", KnowledgePage, { api, tab: "observations" }],
  ["#/memory", KnowledgePage, { api, tab: "observations" }],
]);
