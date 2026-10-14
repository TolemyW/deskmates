// T0: ADR-0022 INT-02. The Gateway's address rule must give the managed egress proxy's verdicts,
// so a tenant-chosen URL the proxy would refuse is refused when the Gateway calls it too.

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isPublicAddress } from "./public-address.js";

const CASES: Array<[string, boolean]> = [
  ["8.8.8.8", true],
  ["1.1.1.1", true],
  ["93.184.216.34", true],
  ["127.0.0.1", false],
  ["127.255.255.254", false],
  ["10.1.2.3", false],
  ["172.16.0.1", false],
  ["172.31.255.255", false],
  ["172.32.0.1", true],
  ["192.168.1.1", false],
  ["169.254.169.254", false],
  ["100.64.0.1", false],
  ["0.0.0.0", false],
  ["224.0.0.1", false],
  ["255.255.255.255", false],
  ["198.18.0.1", false],
  ["::1", false],
  ["::", false],
  ["fe80::1", false],
  ["fc00::1", false],
  ["fd12:3456::1", false],
  ["ff02::1", false],
  ["::ffff:127.0.0.1", false],
  ["::ffff:7f00:1", false],
  ["::ffff:8.8.8.8", true],
  ["2001:4860:4860::8888", true],
  ["not-an-ip", false],
  ["", false],
];

describe("isPublicAddress", () => {
  it.each(CASES)("%s is public: %s", (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected);
  });

  it("agrees with the managed egress proxy on every case", async () => {
    const path = resolve(import.meta.dirname, "../../../../images/egress/egress-policy.mjs");
    const proxy = (await import(path)) as { isPublicAddress(address: string): boolean };
    for (const [address] of CASES)
      expect(isPublicAddress(address), address).toBe(proxy.isPublicAddress(address));
  });
});
