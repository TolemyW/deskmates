// T0: the proxy half of ADR-0027 amendment 1 (decisions 6, 9, 10 and 11). The egress image's
// policy modules are plain ESM files, loaded here as the private-egress test loads them.

import { pathToFileURL } from "node:url";
import { type NetworkGrant, networkGrantAllowsUrl, parseNetworkRules } from "@deskmates/contracts";
import { describe, expect, it, vi } from "vitest";
import { proxyPolicyDocument } from "./docker-provider.js";

const load = (file: string) =>
  import(pathToFileURL(new URL(`../../../images/egress/${file}`, import.meta.url).pathname).href);
const policy = await load("egress-policy.mjs");
const lan = await load("lan-grants.mjs");

const subnet = { kind: "subnet", cidr: "10.20.30.0/24", schemes: ["http"], ports: [23001] };
const host = {
  kind: "host",
  hostname: "console.vendordb.lan",
  address: "10.20.36.35",
  schemes: ["https"],
  ports: [443, 8443],
};
const grants = parseNetworkRules([subnet, host]) as NetworkGrant[];
/** The proxy's own networks in a typical deployment: workspace net and outbound bridge. */
const interfaces = {
  eth0: [{ family: "IPv4", address: "172.30.5.2", cidr: "172.30.5.2/24" }],
  eth1: [{ family: "IPv4", address: "172.31.0.3", cidr: "172.31.0.3/16" }],
};
const HOST_TARGET = "172.31.0.1";

function state(list: string[] = ["*.example.test"], g: unknown[] = grants) {
  const s = policy.createPolicyState();
  s.replace(list, [], g);
  return s;
}

describe("proxy policy document (decision 6)", () => {
  it("keeps the exact old bytes without grants and adds version 2 with them", () => {
    expect(proxyPolicyDocument(["b.test", "a.test"], [], [])).toBe("a.test\nb.test\n");
    const doc = JSON.parse(proxyPolicyDocument(["a.test"], [], grants));
    expect(doc).toEqual({ version: 2, allowlist: ["a.test"], privateTargets: [], grants });
    expect(policy.parsePolicyDocument(JSON.stringify(doc)).grants).toEqual(grants);
  });

  it("rejects grants in version 1 and malformed grants in version 2", () => {
    const v1 = { version: 1, allowlist: [], privateTargets: [], grants };
    expect(() => policy.parsePolicyDocument(JSON.stringify(v1))).toThrow();
    for (const bad of [
      { ...subnet, cidr: "8.8.8.0/24" },
      { ...subnet, cidr: "169.254.0.0/16" },
      { ...subnet, ports: [0] },
      { ...subnet, schemes: ["ftp"] },
      { ...host, address: "127.0.0.1" },
      { ...host, hostname: "host.docker.internal" },
      { ...host, extra: true },
    ]) {
      const doc = { version: 2, allowlist: [], privateTargets: [], grants: [bad] };
      expect(() => policy.parsePolicyDocument(JSON.stringify(doc))).toThrow();
    }
  });
});

describe("proxy grant matching (decisions 10 and 11)", () => {
  const cases: [string, string, number, boolean][] = [
    ["http", "10.20.30.24", 23001, true],
    ["http", "10.20.30.24", 80, false],
    ["https", "10.20.30.24", 23001, false],
    ["http", "10.20.31.24", 23001, false],
    ["https", "console.vendordb.lan", 443, true],
    ["https", "console.vendordb.lan", 8443, true],
    ["http", "console.vendordb.lan", 443, false],
    ["https", "other.vendordb.lan", 443, false],
  ];
  it.each(cases)("%s://%s:%d -> %s, as the hook decides", (scheme, h, port, allowed) => {
    const answer = state().lanTarget(scheme, h, port, HOST_TARGET, interfaces);
    expect(answer !== undefined).toBe(allowed);
    expect(networkGrantAllowsUrl(grants, `${scheme}://${h}:${port}/`)).toBe(allowed);
  });

  it("connects to the pinned address for a host rule and the literal for a subnet", () => {
    const s = state();
    expect(
      s.lanTarget("https", "console.vendordb.lan", 443, HOST_TARGET, interfaces),
    ).toMatchObject({
      address: "10.20.36.35",
      family: 4,
    });
    expect(s.lanTarget("http", "10.20.30.24", 23001, HOST_TARGET, interfaces)).toMatchObject({
      address: "10.20.30.24",
    });
  });

  it("never admits a private target through the public allowlist", async () => {
    const s = state(["*"], []);
    expect(s.lanTarget("http", "10.20.30.24", 23001, HOST_TARGET, interfaces)).toBeUndefined();
    const lookup = vi.fn(async () => [{ address: "10.20.30.24", family: 4 }]);
    await expect(s.resolvePublic("lan.example.test", lookup)).rejects.toThrow("address denied");
    await expect(s.resolvePublic("10.20.30.24", lookup)).rejects.toThrow();
  });

  it("refuses a grant that reaches the proxy's own networks or the host target", () => {
    const own = [
      { kind: "subnet", cidr: "172.30.5.0/24", schemes: ["http"], ports: [80] },
      {
        kind: "host",
        hostname: "gw.lab.test",
        address: HOST_TARGET,
        schemes: ["http"],
        ports: [8080],
      },
    ];
    const s = state([], own);
    expect(() => s.lanTarget("http", "172.30.5.7", 80, HOST_TARGET, interfaces)).toThrow(
      "infrastructure",
    );
    expect(() => s.lanTarget("http", "gw.lab.test", 8080, HOST_TARGET, interfaces)).toThrow(
      "infrastructure",
    );
    expect(lan.isInfrastructureAddress("10.1.2.3", HOST_TARGET, interfaces)).toBe(false);
  });

  it("admits the Docker host's own LAN address from a Testbox-shaped proxy (#124)", () => {
    // The 2026-10-14 T2 failure: proxy on a 192.168.16.0/20 workspace net, host target the
    // docker0 gateway (explicit or the bridge fallback), fixture on the host's eno1 address.
    // The proxy admits it; the 502 there came from a fixture that never listened.
    const testbox = {
      lo: [{ family: "IPv4", address: "127.0.0.1", cidr: "127.0.0.1/8" }],
      eth0: [{ family: "IPv4", address: "192.168.16.2", cidr: "192.168.16.2/20" }],
    };
    const grant = { kind: "subnet", cidr: "10.20.40.132/32", schemes: ["http"], ports: [45123] };
    const s = state([], [grant]);
    for (const target of ["172.17.0.1", "192.168.16.1"]) {
      expect(s.lanTarget("http", "10.20.40.132", 45123, target, testbox)).toMatchObject({
        address: "10.20.40.132",
        family: 4,
      });
    }
    expect(() => s.lanTarget("http", "10.20.40.132", 45123, "10.20.40.132", testbox)).toThrow(
      "infrastructure",
    );
  });

  it("denies an expired grant and forgets grants on revoke and fail-closed", () => {
    const s = state([], [{ ...subnet, expiresAt: "2000-01-01T00:00:00Z" }]);
    expect(s.lanTarget("http", "10.20.30.24", 23001, HOST_TARGET, interfaces)).toBeUndefined();
    const live = state();
    live.replace(["*.example.test"], [], []);
    expect(live.lanTarget("http", "10.20.30.24", 23001, HOST_TARGET, interfaces)).toBeUndefined();
    const closed = state();
    closed.failClosed();
    expect(closed.lanTarget("http", "10.20.30.24", 23001, HOST_TARGET, interfaces)).toBeUndefined();
  });

  it("carries the expiry so open tunnels close when the grant ends", () => {
    const expiresAt = "2099-01-01T00:00:00Z";
    const s = state([], [{ ...subnet, expiresAt }]);
    expect(s.lanTarget("http", "10.20.30.24", 23001, HOST_TARGET, interfaces)?.expiresAt).toBe(
      Date.parse(expiresAt),
    );
  });
});
