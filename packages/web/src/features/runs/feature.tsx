// A run opens in the detail drawer over the screen that was showing; closing it returns there.

import { defineFeature } from "../../app/feature.js";
import { routes } from "./route.js";
import { RunScreen } from "./run.js";

export const feature = defineFeature(routes, {
  readAction: "runs.read",
  drawer: { title: "run.title", closeLabel: "run.close" },
  render: (route, { api }) => <RunScreen runId={route.id} api={api} />,
});
