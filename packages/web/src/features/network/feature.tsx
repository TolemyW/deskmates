// Network profiles have no navigation link; the administrator opens `#/network` directly.

import { defineFeature } from "../../app/feature.js";
import { NetworkScreen } from "./network.js";
import { routes } from "./route.js";

export const feature = defineFeature(routes, {
  render: (_route, { api }) => <NetworkScreen api={api} />,
});
