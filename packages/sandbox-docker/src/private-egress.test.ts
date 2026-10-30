import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
import { parsePrivateEgressTargets } from "@deskmates/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
const policy = await import(
  pathToFileURL(new URL("../../../images/egress/egress-policy.mjs", import.meta.url).pathname).href
);
const expiry = await import(
  pathToFileURL(new URL("../../../images/egress/private-expiry.mjs", import.meta.url).pathname).href
);
const grant = {
  workspaceId: "ws_a",
  hostname: "console.vendordb.test",
  address: "10.88.36.35",
  port: 443,
  expiresAt: "2099-01-01T00:00:00Z",
};
afterEach(() => vi.useRealTimers());
describe("private HTTPS proxy grants", () => {
  it("pins exact addresses without DNS and requires an exact allowlist", async () => {
    const state = policy.createPolicyState();
    const lookup = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]);
    state.replace([grant.hostname], [grant]);
    expect(await state.resolvePublic(grant.hostname, lookup)).toMatchObject({
      address: grant.address,
      family: 4,
    });
    expect(lookup).not.toHaveBeenCalled();
    for (const names of [["*"], ["*.vendordb.test"], []]) {
      state.replace(names, [grant]);
      await expect(state.resolvePublic(grant.hostname, lookup)).rejects.toThrow(
        "private target denied",
      );
    }
  });
  it("denies wrong ports, expired grants, IP literals, other hosts and removed grants", async () => {
    const state = policy.createPolicyState();
    const lookup = vi.fn(async () => [{ address: grant.address, family: 4 }]);
    state.replace([grant.hostname, "other.test"], [grant]);
    for (const port of [80, 444, 3128])
      await expect(state.resolvePublic(grant.hostname, lookup, port)).rejects.toThrow();
    await expect(state.resolvePublic(grant.address, lookup)).rejects.toThrow();
    await expect(state.resolvePublic("other.test", lookup)).rejects.toThrow("address denied");
    state.replace([grant.hostname], [{ ...grant, expiresAt: "2000-01-01T00:00:00Z" }]);
    await expect(state.resolvePublic(grant.hostname, lookup)).rejects.toThrow(
      "private target denied",
    );
    state.replace([grant.hostname]);
    await expect(state.resolvePublic(grant.hostname, lookup)).rejects.toThrow("address denied");
    state.failClosed();
    await expect(state.resolvePublic(grant.hostname, lookup)).rejects.toThrow("hostname denied");
  });
  it("validates the complete policy and fails closed after malformed replacement", async () => {
    const doc = policy.parsePolicyDocument(
      JSON.stringify({ version: 1, allowlist: [grant.hostname], privateTargets: [grant] }),
    );
    expect(doc.privateTargets).toEqual(parsePrivateEgressTargets([grant]));
    expect(() => policy.parsePolicyDocument('{"version":2}')).toThrow();
    for (const patch of [
      { address: "169.254.169.254" },
      { hostname: "*.test" },
      { port: 80 },
      { expiresAt: "never" },
      { workspaceId: "*" },
    ]) {
      expect(() => policy.privateTargets([{ ...grant, ...patch }])).toThrow();
      expect(() => parsePrivateEgressTargets([{ ...grant, ...patch }])).toThrow();
    }
    const state = policy.createPolicyState();
    state.replace([grant.hostname], [grant]);
    expect(() => state.replace([grant.hostname], [{ ...grant, address: "127.0.0.1" }])).toThrow();
    await expect(state.resolvePublic(grant.hostname, async () => [])).rejects.toThrow(
      "hostname denied",
    );
  });
  it("closes an established tunnel on expiry and cancels timers on close", () => {
    vi.useFakeTimers();
    const socket = Object.assign(new EventEmitter(), { destroyed: false, destroy: vi.fn() });
    expiry.expireSocket(socket, Date.now() + 1000);
    vi.advanceTimersByTime(999);
    expect(socket.destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(socket.destroy).toHaveBeenCalledOnce();
    const closed = Object.assign(new EventEmitter(), { destroyed: false, destroy: vi.fn() });
    expiry.expireSocket(closed, Date.now() + 1000);
    closed.emit("close");
    vi.advanceTimersByTime(1000);
    expect(closed.destroy).not.toHaveBeenCalled();
  });
});
