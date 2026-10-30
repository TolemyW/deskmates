// T0: Docker/LAN subnet overlap (ADR-0027 amendment 2 decision 15), with Testbox's shapes: the
// issue's LAN service 172.18.200.24 sits inside the 172.18.0.0/16 Docker bridge there.

import { describe, expect, it } from "vitest";
import {
  cidrsOverlap,
  findNetworkOverlaps,
  networkHolding,
  parseIpv4Cidr,
} from "./network-overlap.js";

const testbox = [
  { name: "bridge", cidr: "172.17.0.0/16" },
  { name: "vendordb-demo-net", cidr: "172.18.0.0/16" },
  { name: "deskmates-ws-1", cidr: "192.168.16.0/20" },
];

describe("IPv4 CIDR overlap", () => {
  it("parses CIDRs and bare addresses, normalizing the base", () => {
    expect(parseIpv4Cidr("172.18.200.24")).toEqual({ base: 0xac12c818, prefix: 32 });
    expect(parseIpv4Cidr("172.18.200.24/16")).toEqual({ base: 0xac120000, prefix: 16 });
    for (const bad of ["", "172.18.0.0/33", "172.18.0/16", "fd00::/8", "1.2.3.4/8/1", "a/8"])
      expect(parseIpv4Cidr(bad), bad).toBeUndefined();
  });

  it("finds containment either way and nothing for disjoint or invalid subnets", () => {
    expect(cidrsOverlap("172.18.200.0/24", "172.18.0.0/16")).toBe(true);
    expect(cidrsOverlap("172.16.0.0/12", "172.18.0.0/16")).toBe(true);
    expect(cidrsOverlap("172.16.180.0/23", "172.18.0.0/16")).toBe(false);
    expect(cidrsOverlap("192.168.15.255/32", "192.168.16.0/20")).toBe(false);
    expect(cidrsOverlap("bogus", "172.18.0.0/16")).toBe(false);
  });
});

describe("findNetworkOverlaps", () => {
  it("names every overlapping target and network, and only those", () => {
    const overlaps = findNetworkOverlaps(
      [
        { source: "profile", label: "VendorDB test environment", cidr: "172.18.200.0/24" },
        { source: "private_target", label: "console.vendordb.lan", cidr: "172.18.201.35/32" },
        { source: "lan_cidr", label: "NETWORK_LAN_CIDRS", cidr: "172.16.0.0/12" },
        { source: "profile", label: "Office", cidr: "172.16.180.0/23" },
      ],
      testbox,
    );
    expect(overlaps.map((o) => `${o.label} ${o.network}`)).toEqual([
      "VendorDB test environment vendordb-demo-net",
      "console.vendordb.lan vendordb-demo-net",
      "NETWORK_LAN_CIDRS bridge",
      "NETWORK_LAN_CIDRS vendordb-demo-net",
    ]);
    expect(overlaps[0]).toMatchObject({ source: "profile", networkCidr: "172.18.0.0/16" });
  });

  it("finds the network holding one address", () => {
    expect(networkHolding("172.18.200.24", testbox)?.name).toBe("vendordb-demo-net");
    expect(networkHolding("10.88.40.132", testbox)).toBeUndefined();
    expect(networkHolding("console.vendordb.lan", testbox)).toBeUndefined();
  });
});
