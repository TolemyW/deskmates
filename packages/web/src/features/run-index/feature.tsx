import { ListChecks } from "lucide-react";
import { defineFeature } from "../../app/feature.js";
import { readableBy } from "../../app/routes.js";
import { routes, runIndexHref } from "./route.js";
import { RunIndexScreen } from "./run-index.js";

export const feature = defineFeature(routes, {
  nav: {
    group: "operate",
    order: 25,
    icon: <ListChecks size={18} />,
    label: "runIndex.nav",
    href: runIndexHref,
    active: (route) => route.name === "runIndex",
    visible: readableBy("run.read"),
  },
  render: (_route, { api }) => <RunIndexScreen api={api} />,
});
