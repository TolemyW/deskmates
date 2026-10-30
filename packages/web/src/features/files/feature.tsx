import { FolderOpen } from "lucide-react";
import { defineFeature } from "../../app/feature.js";
import { readableBy } from "../../app/routes.js";
import { FilesScreen } from "./files.js";
import { HtmlReader } from "./html-reader.js";
import { filesHref, routes } from "./route.js";

export const feature = defineFeature(routes, {
  nav: {
    group: "resources",
    order: 10,
    icon: <FolderOpen size={18} />,
    label: "app.nav.files",
    href: filesHref,
    active: (route) => route.name === "files" || route.name === "fileReader",
    visible: readableBy("files.read"),
  },
  render: (route, { api }) =>
    route.name === "fileReader" ? (
      <HtmlReader
        key={`${route.workspaceId}:${route.path}`}
        api={api}
        workspaceId={route.workspaceId}
        path={route.path}
      />
    ) : (
      <FilesScreen
        api={api}
        target={{
          ...(route.workspaceId ? { workspaceId: route.workspaceId } : {}),
          ...(route.path ? { path: route.path } : {}),
        }}
      />
    ),
});
