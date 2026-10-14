import { describe, expect, it } from "vitest";
import { hostException, hostPort, resolveHostTarget } from "./host-target.mjs";

describe("reserved host target", () => {
  it("pins the default target from outbound DNS and falls back only when that alias is absent", async () => {
    const found = await resolveHostTarget("host.docker.internal", "172.18.0.1", async () => [
      { address: "192.168.5.2", family: 4 },
    ]);
    expect(found).toBe("192.168.5.2");
    const missing = Object.assign(new Error("missing"), { code: "ENOTFOUND" });
    expect(
      await resolveHostTarget("host.docker.internal", "172.18.0.1", async () => {
        throw missing;
      }),
    ).toBe("172.18.0.1");
    await expect(
      resolveHostTarget("gateway.example", "172.18.0.1", async () => {
        throw missing;
      }),
    ).rejects.toBe(missing);
  });

  it("falls back when a DNS interceptor answers the reserved name with a non-private address", async () => {
    // Testbox, 2026-09-28: a Mihomo TUN answers every port-53 query, host.docker.internal
    // included, with a fake IP in 198.18.0.0/15, so the proxy connected there and every model
    // and ledger request through the host exception failed with 502.
    for (const address of ["198.18.0.83", "8.8.8.8", "2001:db8::1"]) {
      const family = address.includes(":") ? 6 : 4;
      expect(
        await resolveHostTarget("host.docker.internal", "172.22.0.1", async () => [
          { address, family },
        ]),
      ).toBe("172.22.0.1");
    }
    for (const address of ["192.168.65.254", "172.17.0.1", "10.0.2.2", "127.0.0.1", "fd00::2"]) {
      const family = address.includes(":") ? 6 : 4;
      expect(
        await resolveHostTarget("host.docker.internal", "172.22.0.1", async () => [
          { address, family },
        ]),
      ).toBe(address);
    }
  });

  it("does not second-guess an operator-chosen host target", async () => {
    expect(
      await resolveHostTarget("gateway.example", "172.22.0.1", async () => [
        { address: "198.18.0.9", family: 4 },
      ]),
    ).toBe("198.18.0.9");
  });

  it("accepts only the exact reserved request name and a bounded port", () => {
    expect(hostException("host.docker.internal")).toBe(true);
    for (const name of [
      "x.host.docker.internal",
      "host.docker.internal.evil",
      "127.0.0.1",
      "HOST.DOCKER.INTERNAL.",
    ]) {
      expect(hostException(name)).toBe(false);
    }
    expect(hostPort("", 80)).toBe(80);
    expect(hostPort("8080", 80)).toBe(8080);
    for (const port of ["0", "65536", "1.2", "foo"]) expect(() => hostPort(port, 80)).toThrow();
  });

  it("refuses malformed infrastructure configuration", async () => {
    await expect(resolveHostTarget("host.docker.internal", "bad", async () => [])).rejects.toThrow(
      "fallback",
    );
    await expect(
      resolveHostTarget("host.docker.internal/evil", "172.18.0.1", async () => []),
    ).rejects.toThrow("target");
    await expect(
      resolveHostTarget("host.docker.internal", "172.18.0.1", async () => []),
    ).rejects.toThrow("numeric");
  });
});
