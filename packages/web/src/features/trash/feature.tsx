// Workspace trash has no navigation link; it opens from the workspace switcher.

import { defineFeature } from "../../app/feature.js";
import { routes } from "./route.js";
import { WorkspaceTrashScreen } from "./workspace-trash.js";

export const feature = defineFeature(routes, {
  render: (_route, { api }) => <WorkspaceTrashScreen api={api} />,
});
