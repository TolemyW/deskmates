// @vitest-environment jsdom
// T0: the Tasks navigation entry and screen.

import { ClipboardList } from "lucide-react";
import {
  STUB_CONTEXT,
  describeNavEntry,
  describeRender,
} from "../../app/testing/feature-expectations.js";
import { feature } from "./feature.js";
import { TasksScreen } from "./tasks.js";

describeNavEntry({
  folder: "tasks",
  feature,
  group: "talk",
  order: 20,
  icon: ClipboardList,
  label: "app.nav.tasks",
  english: "Tasks",
  href: "#/tasks",
  currentAt: ["#/tasks", "#/tasks/tsk_1"],
  visibleTo: { manager: true, member: true },
});

describeRender("tasks", [
  ["#/tasks", TasksScreen, { api: STUB_CONTEXT.api, taskId: undefined }],
  ["#/tasks/tsk_1", TasksScreen, { api: STUB_CONTEXT.api, taskId: "tsk_1" }],
]);
