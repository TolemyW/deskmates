import { describe, expect, it } from "vitest";
import {
  type NetworkGrant,
  earlierExpiry,
  networkGrantAllowsUrl,
  networkGrantFor,
  parseNetworkRules,
} from "./network-profile.js";
import { egressAllows } from "./workspace.js";

const subnet = { kind: "subnet", cidr: "10.20.30.0/24", schemes: ["http"], ports: [23001] };
const host = {
  kind: "host",
  hostname: "console.vendordb.lan",
  address: "10.20.36.35",
  schemes: ["https"],
  ports: [443, 8443],
};

describe("network rule parsing (ADR-0027 amendment 1 decision 9)", () => {
  it("accepts host and subnet rules and normalizes schemes and ports", () => {
    expect(
      parseNetworkRules([
        { ...subnet, schemes: ["https", "http", "http"], ports: [8080, 80, 8080] },
        host,
      ]),
    ).toEqual([
      { kind: "subnet", cidr: "10.20.30.0/24", schemes: ["http", "https"], ports: [80, 8080] },
      host,
    ]);
    expect(parseNetworkRules([{ ...subnet, cidr: "10.0.0.0/8" }])[0]).toMatchObject({
      cidr: "10.0.0.0/8",
    });
    expect(parseNetworkRules([{ ...subnet, cidr: "192.168.1.7/32" }])).toHaveLength(1);
  });

  it.each([
    ["public cidr", { ...subnet, cidr: "8.8.8.0/24" }],
    ["cidr wider than its block", { ...subnet, cidr: "172.0.0.0/8" }],
    ["host bits set", { ...subnet, cidr: "10.20.30.1/24" }],
    ["CGNAT", { ...subnet, cidr: "100.64.0.0/10" }],
    ["link-local metadata", { ...subnet, cidr: "169.254.169.254/32" }],
    ["loopback", { ...subnet, cidr: "127.0.0.0/8" }],
    ["noncanonical cidr", { ...subnet, cidr: "10.020.30.0/24" }],
    ["IPv6", { ...subnet, cidr: "fd00::/8" }],
    ["no schemes", { ...subnet, schemes: [] }],
    ["ftp", { ...subnet, schemes: ["ftp"] }],
    ["port 0", { ...subnet, ports: [0] }],
    ["port too large", { ...subnet, ports: [65536] }],
    ["too many ports", { ...subnet, ports: Array.from({ length: 17 }, (_, i) => i + 1) }],
    ["no ports", { ...subnet, ports: [] }],
    ["wildcard host", { ...host, hostname: "*.vendordb.lan" }],
    ["IP-literal hostname", { ...host, hostname: "10.20.36.35" }],
    ["reserved host", { ...host, hostname: "host.docker.internal" }],
    ["localhost name", { ...host, hostname: "a.localhost" }],
    ["uppercase host", { ...host, hostname: "Console.vendordb.lan" }],
    ["public pinned address", { ...host, address: "1.1.1.1" }],
    ["metadata pinned address", { ...host, address: "169.254.169.254" }],
    ["unknown field", { ...host, extra: 1 }],
    ["unknown kind", { ...subnet, kind: "any" }],
  ])("rejects %s", (_name, rule) => {
    expect(() => parseNetworkRules([rule])).toThrow(/network rule/);
  });

  it("rejects an empty list, an oversized list and a duplicated host", () => {
    expect(() => parseNetworkRules([])).toThrow();
    expect(() => parseNetworkRules(Array.from({ length: 65 }, () => subnet))).toThrow();
    expect(() => parseNetworkRules([host, host])).toThrow(/one host rule/);
  });

  it("takes the earlier of two expiries", () => {
    expect(earlierExpiry(undefined, undefined)).toBeUndefined();
    expect(earlierExpiry("2026-10-20T00:00:00Z", undefined)).toBe("2026-10-20T00:00:00Z");
    expect(earlierExpiry("2026-10-20T00:00:00Z", "2026-10-19T00:00:00Z")).toBe(
      "2026-10-19T00:00:00Z",
    );
  });
});

describe("network grant matching (decisions 10 and 11)", () => {
  const grants = parseNetworkRules([subnet, host]) as NetworkGrant[];
  it.each([
    ["http://10.20.30.24:23001/", true],
    ["http://10.20.30.24:23001/path?q=1", true],
    ["https://10.20.30.24:23001/", false],
    ["http://10.20.30.24/", false],
    ["http://10.20.31.24:23001/", false],
    ["http://0x0a.20.30.24:23001/", true],
    ["https://console.vendordb.lan/", true],
    ["https://console.vendordb.lan:8443/x", true],
    ["http://console.vendordb.lan/", false],
    ["https://sub.console.vendordb.lan/", false],
    ["https://user:pw@console.vendordb.lan/", false],
    ["ftp://10.20.30.24:23001/", false],
    ["not a url", false],
  ])("%s -> %s", (url, allowed) => {
    expect(networkGrantAllowsUrl(grants, url)).toBe(allowed);
  });

  it("denies an expired grant", () => {
    const expiring = [{ ...(grants[0] as NetworkGrant), expiresAt: "2026-10-14T00:00:00Z" }];
    const target = { scheme: "http", host: "10.20.30.24", port: 23001 };
    expect(networkGrantFor(expiring, target, Date.parse("2026-10-13T23:59:59Z"))).toBeDefined();
    expect(networkGrantFor(expiring, target, Date.parse("2026-10-14T00:00:00Z"))).toBeUndefined();
  });

  it("never lets the public allowlist admit a private target", () => {
    expect(egressAllows("10.20.30.24", ["*"])).toBe(false);
    expect(networkGrantAllowsUrl([], "http://10.20.30.24:23001/")).toBe(false);
  });
});
