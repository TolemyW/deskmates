// T1: Docker/LAN subnet overlap (ADR-0027 amendment 2 decision 15). Every LAN target the Gateway
// knows is compared with the provider's networks; the root reads the report, startup warns once
// per overlap, and nothing is refused or changed.

import type { NetworkProfile } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { readSandboxConfig } from "../config/sandbox.js";
import { type Harness, startHarness } from "../test-support/harness.js";
import { reportNetworkOverlaps } from "./network-overlaps.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const BIBICLAW = [
  { name: "bridge", cidr: "172.17.0.0/16" },
  { name: "vendordb-demo-net", cidr: "172.18.0.0/16" },
];

async function setup() {
  h = await startHarness({
    lanCidrs: ["172.16.180.0/23", "172.16.0.0/12"],
    privateEgressTargets: [
      {
        workspaceId: "ws_x",
        hostname: "kb.lab.test",
        address: "172.17.9.9",
        port: 443,
        expiresAt: "2099-01-01T00:00:00Z",
      },
    ],
  });
  Object.assign(h.provider, { networkSubnets: async () => BIBICLAW });
  const created = await h.api<{ profile: NetworkProfile }>("POST", "/api/network-profiles", {
    name: "VendorDB test environment",
    rules: [{ kind: "subnet", cidr: "10.20.30.0/24", schemes: ["http"], ports: [23001] }],
  });
  expect(created.status).toBe(200);
  return h;
}

describe("Docker/LAN subnet overlap", () => {
  it("lists each overlapping target for the root, from every source", async () => {
    const harness = await setup();
    const res = await harness.api<{
      checked: boolean;
      overlaps: { source: string; label: string; network: string }[];
    }>("GET", "/api/network-overlaps");
    expect(res.status).toBe(200);
    expect(res.json.checked).toBe(true);
    expect(res.json.overlaps.map((o) => `${o.source}:${o.label}:${o.network}`)).toEqual([
      "profile:VendorDB test environment:vendordb-demo-net",
      "private_target:kb.lab.test:bridge",
      "lan_cidr:NETWORK_LAN_CIDRS:bridge",
      "lan_cidr:NETWORK_LAN_CIDRS:vendordb-demo-net",
    ]);
  });

  it("warns once per overlap at startup and never throws", async () => {
    const harness = await setup();
    const warnings: string[] = [];
    const found = await reportNetworkOverlaps(harness.app.deskmates.ctx, (m) => warnings.push(m));
    expect(found).toHaveLength(4);
    expect(warnings[0]).toBe(
      "LAN target 10.20.30.0/24 (profile VendorDB test environment) overlaps Docker network vendordb-demo-net (172.18.0.0/16): the host routes it to that bridge, not the LAN",
    );
    Object.assign(harness.provider, {
      networkSubnets: async () => {
        throw new Error("daemon down");
      },
    });
    const failed: string[] = [];
    expect(await reportNetworkOverlaps(harness.app.deskmates.ctx, (m) => failed.push(m))).toEqual(
      [],
    );
    expect(failed).toEqual(["Docker/LAN subnet overlap not checked: Error: daemon down"]);
  });

  it("reads NETWORK_LAN_CIDRS as IPv4 CIDRs and refuses anything else", () => {
    const read = (value: string) => readSandboxConfig({ NETWORK_LAN_CIDRS: value }).lanCidrs;
    expect(read(" 172.16.180.0/23, 10.0.0.0/8 ")).toEqual(["172.16.180.0/23", "10.0.0.0/8"]);
    expect(read("")).toBeUndefined();
    for (const bad of ["10.20.40.132", "lan.example/24", "fd00::/8", "10.0.0.0/33"])
      expect(() => read(bad), bad).toThrow("NETWORK_LAN_CIDRS");
  });

  it("reports nothing checked when the provider cannot list networks", async () => {
    h = await startHarness();
    const res = await h.api("GET", "/api/network-overlaps");
    expect(res.json).toEqual({ checked: false, networks: [], overlaps: [] });
  });
});
