import { Puzzle } from "lucide-react";
import { defineFeature } from "../../app/feature.js";
import { readableBy } from "../../app/routes.js";
import { routes, skillsHref } from "./route.js";
import { SkillsScreen } from "./skills.js";

export const feature = defineFeature(routes, {
  nav: {
    group: "resources",
    order: 30,
    icon: <Puzzle size={18} />,
    label: "app.nav.skills",
    href: skillsHref,
    active: (route) => route.name === "skills",
    visible: readableBy("skills.read"),
  },
  render: (_route, { api }) => <SkillsScreen api={api} />,
});
