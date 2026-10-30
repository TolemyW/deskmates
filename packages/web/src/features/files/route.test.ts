// @vitest-environment node
// T0: the Files route. Only `#/resources/files` opens it; a workspace and a path open one file
// there (ADR-0014 amendment A7).

import { describeRoutes } from "../../app/testing/route-expectations.js";
import { fileReadHref, filesHref, routes } from "./route.js";

describeRoutes({
  owner: "files",
  module: routes,
  screens: { files: "workspaces", fileReader: "workspaces" },
  addresses: [
    ["#/files", { name: "notFound", path: "files" }],
    ["#/resources", { name: "home" }],
    ["#/resources/files", { name: "files" }],
    [
      "#/resources/files?workspace=ws_1&path=%2Fwork%2Freport.html&view=read",
      { name: "fileReader", workspaceId: "ws_1", path: "/work/report.html" },
    ],
    ["#/resources/other", { name: "home" }],
    [
      "#/resources/files?workspace=ws_1&path=%2Fwork%2Fuploads%2Fa.md",
      { name: "files", workspaceId: "ws_1", path: "/work/uploads/a.md" },
    ],
  ],
  hrefs: [
    [
      fileReadHref({ workspaceId: "ws_1", path: "/work/report.html" }),
      "#/resources/files?workspace=ws_1&path=%2Fwork%2Freport.html&view=read",
      { name: "fileReader", workspaceId: "ws_1", path: "/work/report.html" },
    ],
    [filesHref(), "#/resources/files", { name: "files" }],
    [
      filesHref({ workspaceId: "ws_1", path: "/home/nova/out put.csv" }),
      "#/resources/files?workspace=ws_1&path=%2Fhome%2Fnova%2Fout+put.csv",
      { name: "files", workspaceId: "ws_1", path: "/home/nova/out put.csv" },
    ],
  ],
  viewed: [["#/resources/files", "files", "workspaces", "files", "workspaces"]],
});
