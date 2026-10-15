// @vitest-environment jsdom
// T0: the Network navigation entry shows to the administrator account and workspace Owners
// (ADR-0027 amendment 1 decision 12, owner-decided 2026-10-14), and the screen.

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

it("shows the link to the root and to an Owner of any workspace, not to an Admin", () => {
  const visible = (roles: SessionRoles) =>
    feature.nav?.visible?.({ manager: true, can: (a) => mayTakeAction(roles, a, "ws_1") });
  expect(visible({ tenantRole: "owner", platformMaintainer: true, root: true })).toBe(true);
  // An Owner elsewhere sees it while another workspace is selected (the route names none).
  expect(
    visible({
      tenantRole: "owner",
      platformMaintainer: false,
      workspaceRoles: { ws_1: "member", ws_2: "owner" },
    }),
  ).toBe(true);
  expect(
    visible({ tenantRole: "admin", platformMaintainer: false, workspaceRoles: { ws_1: "admin" } }),
  ).toBe(false);
});

describeRender("network", [["#/network", NetworkScreen, { api: STUB_CONTEXT.api }]]);
