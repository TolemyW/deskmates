import { BookOpen } from "lucide-react";
import { defineFeature } from "../../app/feature.js";
import { readableBy } from "../../app/routes.js";
import { KnowledgePage } from "./knowledge-page.js";
import { knowledgeHref, routes } from "./route.js";

export const feature = defineFeature(routes, {
  nav: {
    group: "resources",
    audience: "tune",
    order: 20,
    icon: <BookOpen size={18} />,
    label: "app.nav.knowledge",
    href: () => knowledgeHref(),
    active: (route) => route.name === "knowledge",
    visible: readableBy("knowledge.read"),
  },
  render: (route, { api }) => <KnowledgePage api={api} tab={route.tab} />,
});
