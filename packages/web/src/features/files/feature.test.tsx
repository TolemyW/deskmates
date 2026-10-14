// @vitest-environment jsdom
// T0: the Files navigation entry and screen.

import { FolderOpen } from "lucide-react";
import {
  STUB_CONTEXT,
  describeNavEntry,
  describeRender,
} from "../../app/testing/feature-expectations.js";
import { feature } from "./feature.js";
import { FilesScreen } from "./files.js";

describeNavEntry({
  folder: "files",
  feature,
  group: "resources",
  order: 10,
  icon: FolderOpen,
  label: "app.nav.files",
  english: "Files",
  href: "#/resources/files",
  currentAt: ["#/resources/files"],
  visibleTo: { manager: true, member: true },
});

describeRender("files", [["#/resources/files", FilesScreen, { api: STUB_CONTEXT.api }]]);
