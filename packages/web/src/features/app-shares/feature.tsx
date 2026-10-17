// Published apps: the entry page `#/apps/<share>?ws=<workspace>`, opened from a workspace's Apps list
// or from the sign-in hint the app origin shows. The list lives in the workspace detail page.

import { defineFeature } from "../../app/feature.js";
import { AppOpenScreen } from "./app-open-screen.js";
import { routes } from "./route.js";

export const feature = defineFeature(routes, {
  render: (route, { api }) => (
    <AppOpenScreen
      api={api}
      workspaceId={route.workspaceId}
      shareId={route.shareId}
      {...(route.path ? { path: route.path } : {})}
    />
  ),
});
