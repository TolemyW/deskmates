// T0: which sections of a workspace's detail page are tuning (docs/use-and-tune-views.md). The use
// view keeps what a person who works with the bots decides: the name, the network policy, the
// approval mode, the people, published apps and archiving.
import { expect, it } from "vitest";
import { WORKSPACE_DETAIL_SECTIONS } from "./detail-sections.js";

it("marks the operations sections for the tune view and keeps the everyday ones in both", () => {
  const tune = WORKSPACE_DETAIL_SECTIONS.filter(({ audience }) => audience === "tune");
  const use = WORKSPACE_DETAIL_SECTIONS.filter(({ audience }) => audience !== "tune");
  expect(tune.map(({ key }) => key)).toEqual([
    "network-profiles",
    "limits",
    "workdir",
    "desktop-tools",
  ]);
  expect(use.map(({ key }) => key)).toEqual([
    "name",
    "network",
    "web-search",
    "auto-approval",
    "people",
    "apps",
    "archive",
  ]);
});

it("keeps web search beside network policy in the same everyday settings group", () => {
  const network = WORKSPACE_DETAIL_SECTIONS.findIndex((s) => s.key === "network");
  const search = WORKSPACE_DETAIL_SECTIONS[network + 1];
  expect(search).toMatchObject({ key: "web-search", group: "environment" });
  expect(search?.audience).toBeUndefined();
});
