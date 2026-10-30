// @vitest-environment node
// T0: the tasks routes.

import { describeRoutes } from "../../app/testing/route-expectations.js";
import { routes, taskHref } from "./route.js";

describeRoutes({
  owner: "tasks",
  module: routes,
  screens: { tasks: "tasks" },
  addresses: [
    ["#/task-kinds", { name: "tasks" }, "#/tasks"],
    ["#/task-kinds/support-ticket", { name: "tasks" }, "#/tasks"],
    ["#/tasks", { name: "tasks" }],
    ["#/tasks/", { name: "tasks" }, "#/tasks"],
    ["#/tasks/task_1", { name: "tasks", id: "task_1" }],
    ["#/tasks/a%2Fb", { name: "tasks", id: "a/b" }],
  ],
  hrefs: [
    [taskHref(), "#/tasks", { name: "tasks" }],
    [taskHref("t/1"), "#/tasks/t%2F1", { name: "tasks", id: "t/1" }],
  ],
  viewed: [["#/tasks", "tasks", "tasks", "tasks", "tasks"]],
});
