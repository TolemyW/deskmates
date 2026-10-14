// T0: ADR-0022 decision 2 / test plan AUTH-01 throttling. Attempts reserve budget when admitted,
// before any password work, so in-flight attempts count as well as finished failures.

import { describe, expect, it } from "vitest";
import { LoginThrottle, type ThrottleTicket } from "./login-throttle.js";

function ticket(result: ReturnType<LoginThrottle["admit"]>): ThrottleTicket {
  if (!("ticket" in result)) throw new Error(`refused: ${result.retryAfterMs} ms`);
  return result.ticket;
}

describe("login throttle", () => {
  it("refuses a login name after its failure budget until the window ends", () => {
    let now = new Date("2026-10-05T00:00:00.000Z");
    const throttle = new LoginThrottle(
      { windowMs: 60_000, perLoginName: 3, perAddress: 100 },
      () => now,
    );
    for (let i = 0; i < 3; i++) ticket(throttle.admit("alice", "a1")).failed();
    expect(throttle.admit("alice", "a2")).toEqual({ retryAfterMs: 60_000 });
    expect("ticket" in throttle.admit("bob", "a2")).toBe(true);
    now = new Date(now.getTime() + 60_000);
    expect("ticket" in throttle.admit("alice", "a1")).toBe(true);
  });

  it("counts in-flight attempts: concurrent attempts cannot exceed the budget", () => {
    const throttle = new LoginThrottle({ windowMs: 60_000, perLoginName: 5, perAddress: 100 });
    const inFlight = Array.from({ length: 5 }, () => ticket(throttle.admit("alice", "a")));
    // The sixth arrives while five are still hashing: refused before any work.
    const sixth = throttle.admit("alice", "a");
    expect(sixth).toEqual({ retryAfterMs: 1000 });
    for (const t of inFlight) t.failed();
    expect((throttle.admit("alice", "a") as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(
      1000,
    );
  });

  it("refuses an address that sprays many login names, in flight or finished", () => {
    const throttle = new LoginThrottle({ windowMs: 60_000, perLoginName: 100, perAddress: 4 });
    ticket(throttle.admit("a", "spray")).failed();
    ticket(throttle.admit("b", "spray")).failed();
    ticket(throttle.admit("c", "spray"));
    ticket(throttle.admit("d", "spray"));
    expect("retryAfterMs" in throttle.admit("e", "spray")).toBe(true);
    expect("ticket" in throttle.admit("e", "elsewhere")).toBe(true);
  });

  it("only a success clears the login name's failures; a release frees the slot only", () => {
    const throttle = new LoginThrottle({ windowMs: 60_000, perLoginName: 2, perAddress: 100 });
    ticket(throttle.admit("alice", "a")).failed();
    const released = ticket(throttle.admit("alice", "a"));
    released.released();
    released.failed(); // ignored: the first outcome counts
    ticket(throttle.admit("alice", "a")).failed();
    expect("retryAfterMs" in throttle.admit("alice", "a")).toBe(true);

    const fresh = new LoginThrottle({ windowMs: 60_000, perLoginName: 2, perAddress: 100 });
    ticket(fresh.admit("alice", "a")).failed();
    ticket(fresh.admit("alice", "a")).succeeded();
    ticket(fresh.admit("alice", "a")).failed();
    expect("ticket" in fresh.admit("alice", "a")).toBe(true);
  });

  it("a refused attempt stores nothing: spraying login names from a limited address", () => {
    const throttle = new LoginThrottle({ windowMs: 60_000, perLoginName: 5, perAddress: 3 });
    for (const name of ["a", "b", "c"]) ticket(throttle.admit(name, "spray")).failed();
    const held = throttle.size;
    for (let i = 0; i < 10_000; i++)
      expect("retryAfterMs" in throttle.admit(`name-${i}`, "spray")).toBe(true);
    expect(throttle.size).toBe(held);
    // The same holds for a limited login name tried from many addresses.
    const byName = new LoginThrottle({ windowMs: 60_000, perLoginName: 2, perAddress: 100 });
    for (const address of ["x", "y"]) ticket(byName.admit("alice", address)).failed();
    const heldByName = byName.size;
    for (let i = 0; i < 1_000; i++) byName.admit("alice", `10.0.${i >> 8}.${i & 255}`);
    expect(byName.size).toBe(heldByName);
  });

  it("holds at most maxKeys without dropping live failures or attempts in flight", () => {
    let now = new Date("2026-10-05T00:00:00.000Z");
    const throttle = new LoginThrottle(
      { windowMs: 60_000, perLoginName: 5, perAddress: 5, maxKeys: 20 },
      () => now,
    );
    const inFlight = ticket(throttle.admit("held", "held-addr"));
    for (let i = 0; i < 500; i++) {
      const attempt = throttle.admit(`user-${i}`, `addr-${i}`);
      if (i < 9) ticket(attempt).failed();
      else expect(attempt).toEqual({ retryAfterMs: 1000 });
      expect(throttle.size).toBeLessThanOrEqual(20);
    }
    // The in-flight reservation survived capacity pressure: its budget is still held.
    const limited = new LoginThrottle(
      { windowMs: 60_000, perLoginName: 1, perAddress: 100, maxKeys: 4 },
      () => now,
    );
    const pending = ticket(limited.admit("alice", "a"));
    for (let i = 0; i < 50; i++) ticket(limited.admit(`other-${i}`, `b-${i}`)).released();
    expect(limited.admit("alice", "elsewhere")).toEqual({ retryAfterMs: 1000 });
    pending.failed();
    expect(limited.admit("alice", "elsewhere")).toEqual({ retryAfterMs: 60_000 });
    inFlight.released();
    ticket(throttle.admit("last", "last-addr")).failed();
    // Capacity pressure reclaims expired keys without discarding live ones.
    now = new Date(now.getTime() + 60_000);
    ticket(throttle.admit("fresh", "fresh-addr")).failed();
    expect(throttle.size).toBe(2);
  });
});
