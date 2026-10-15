// @vitest-environment jsdom
// T0: the Network navigation entry shows to the administrator account only, and the screen.

import { type SessionRoles, mayTakeAction } from "@deskmates/contracts";
import { Network } from "lucide-react";
import { expect, it } from "vitest";
import {
  STUB_CONTEXT,
  describeNavEntry,
  describeRender,
} from "../../app/testing/feature-expectations.js";
import { feature } from "./feature.js";
import { NetworkScreen } from "./network.js";

describeNavEntry({
  folder: "network",
  feature,
  group: "operate",
  order: 50,
  icon: Network,
  label: "network.nav",
  english: "Network",
  href: "#/network",
  currentAt: ["#/network"],
  // Without role facts every link shows and the Gateway decides; the root check is below.
  visibleTo: { manager: true, member: true },
});

it("shows the link to the root and hides it from an Owner of every workspace", () => {
  const visible = (roles: SessionRoles) =>
    feature.nav?.visible?.({ manager: true, can: (a) => mayTakeAction(roles, a, "ws_1") });
  expect(visible({ tenantRole: "owner", platformMaintainer: true, root: true })).toBe(true);
  expect(
    visible({ tenantRole: "owner", platformMaintainer: true, workspaceRoles: { ws_1: "owner" } }),
  ).toBe(false);
});

describeRender("network", [["#/network", NetworkScreen, { api: STUB_CONTEXT.api }]]);
