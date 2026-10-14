import { FolderOpen } from "lucide-react";
import { defineFeature } from "../../app/feature.js";
import { readableBy } from "../../app/routes.js";
import { FilesScreen } from "./files.js";
import { filesHref, routes } from "./route.js";

export const feature = defineFeature(routes, {
  nav: {
    group: "resources",
    order: 10,
    icon: <FolderOpen size={18} />,
    label: "app.nav.files",
    href: filesHref,
    active: (route) => route.name === "files",
    visible: readableBy("files.read"),
  },
  render: (_route, { api }) => <FilesScreen api={api} />,
});
