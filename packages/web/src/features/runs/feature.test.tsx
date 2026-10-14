// @vitest-environment jsdom
// T0: a run opens in the detail drawer, titled and closed with the run labels; it has no
// navigation entry of its own.

import { expect, it } from "vitest";
import { STUB_CONTEXT, describeRender } from "../../app/testing/feature-expectations.js";
import { feature } from "./feature.js";
import { RunScreen } from "./run.js";

it("opens in the drawer with the run's title and close labels", () => {
  expect(feature.nav).toBeUndefined();
  expect(feature.drawer).toEqual({ title: "run.title", closeLabel: "run.close" });
});

describeRender("runs", [["#/runs/run_1", RunScreen, { api: STUB_CONTEXT.api, runId: "run_1" }]]);
