// @vitest-environment jsdom
// T0: the workspace trash has no navigation entry, and no entry is current on it.

import { expect, it } from "vitest";
import {
  STUB_CONTEXT,
  currentEntries,
  describeRender,
} from "../../app/testing/feature-expectations.js";
import { feature } from "./feature.js";
import { WorkspaceTrashScreen } from "./workspace-trash.js";

it("has no navigation entry, and no entry is current on it", () => {
  expect(feature.nav).toBeUndefined();
  expect(currentEntries("#/trash")).toEqual([]);
});

describeRender("trash", [["#/trash", WorkspaceTrashScreen, { api: STUB_CONTEXT.api }]]);
