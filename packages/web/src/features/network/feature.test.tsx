// @vitest-environment jsdom
// T0: network profiles have no navigation entry, and no entry is current on the screen.

import { expect, it } from "vitest";
import {
  STUB_CONTEXT,
  currentEntries,
  describeRender,
} from "../../app/testing/feature-expectations.js";
import { feature } from "./feature.js";
import { NetworkScreen } from "./network.js";

it("has no navigation entry, and no entry is current on it", () => {
  expect(feature.nav).toBeUndefined();
  expect(currentEntries("#/network")).toEqual([]);
});

describeRender("network", [["#/network", NetworkScreen, { api: STUB_CONTEXT.api }]]);
