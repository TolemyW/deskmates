import { describe, expect, it } from "vitest";
import { parsePrivateEgressTargets } from "./private-egress.js";
const target = {
  workspaceId: "ws_a",
  hostname: "console.vendordb.test",
  address: "10.20.36.35",
  port: 443,
  expiresAt: "2026-10-12T00:00:00Z",
};
describe("operator private egress grants", () => {
  it("accepts exact RFC1918 targets and preserves expiration", () => {
    expect(parsePrivateEgressTargets([target])).toEqual([target]);
    expect(parsePrivateEgressTargets([])).toEqual([]);
  });
  it.each([
    "127.0.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "198.18.0.1",
    "8.8.8.8",
    "::1",
    "fd00::1",
    "172.32.0.1",
    "10.020.36.35",
    "10.256.0.1",
  ])("rejects special or noncanonical address %s", (address) => {
    expect(() => parsePrivateEgressTargets([{ ...target, address }])).toThrow();
  });
  it.each([
    "*",
    "*.vendordb.test",
    "10.20.36.35",
    "localhost",
    "x.localhost",
    "host.docker.internal",
    "https://console.test",
    "CONSOLE.test",
    "console.test/",
    "console.test:443",
  ])("rejects non-exact hostname %s", (hostname) => {
    expect(() => parsePrivateEgressTargets([{ ...target, hostname }])).toThrow();
  });
  it("requires a bounded unambiguous complete declaration", () => {
    for (const value of [
      null,
      {},
      [null],
      [target, target],
      Array(65).fill(target),
      [{ ...target, port: 80 }],
      [{ ...target, expiresAt: "never" }],
      [{ ...target, workspaceId: "*" }],
      [{ ...target, extra: true }],
    ])
      expect(() => parsePrivateEgressTargets(value)).toThrow();
    expect(parsePrivateEgressTargets([target, { ...target, workspaceId: "ws_b" }])).toHaveLength(2);
  });
});
