// T0: ADR-0022 decision 4 / test plan AUTH-04. Connections authenticated once at open are closed
// on revocation, either explicitly or by the periodic re-check.

import { describe, expect, it, vi } from "vitest";
import { LiveConnections } from "./live-connections.js";

describe("live connections", () => {
  it("closes exactly the revoked session's connections", () => {
    const live = new LiveConnections(() => true, 0);
    const a1 = vi.fn();
    const a2 = vi.fn();
    const b = vi.fn();
    live.register("a", a1);
    live.register("a", a2);
    live.register("b", b);
    expect(live.closeSessions(["a"])).toBe(2);
    expect(a1).toHaveBeenCalledOnce();
    expect(a2).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
    expect(live.count()).toBe(1);
  });

  it("unregistering a closed connection is harmless and keeps others", () => {
    const live = new LiveConnections(() => true, 0);
    const close = vi.fn();
    const unregister = live.register("a", close);
    const other = live.register("a", vi.fn());
    unregister();
    unregister();
    expect(live.count("a")).toBe(1);
    other();
    expect(live.count()).toBe(0);
  });

  it("the sweep closes sessions that are no longer authorized", async () => {
    const authorized = new Set(["a", "b"]);
    const live = new LiveConnections((id) => authorized.has(id), 10);
    const a = vi.fn();
    const b = vi.fn();
    live.register("a", a);
    live.register("b", b);
    authorized.delete("b");
    await vi.waitFor(() => expect(b).toHaveBeenCalledOnce(), { timeout: 1000 });
    expect(a).not.toHaveBeenCalled();
    live.stop();
  });
});
