import { ClipboardList } from "lucide-react";
import { defineFeature } from "../../app/feature.js";
import { readableBy } from "../../app/routes.js";
import { routes, taskHref } from "./route.js";
import { TasksScreen } from "./tasks.js";

export const feature = defineFeature(routes, {
  nav: {
    group: "talk",
    order: 20,
    icon: <ClipboardList size={18} />,
    label: "app.nav.tasks",
    href: () => taskHref(),
    active: (route) => route.name === "tasks",
    visible: readableBy("tasks.read"),
  },
  render: (route, { api }) => <TasksScreen api={api} taskId={route.id} />,
});
