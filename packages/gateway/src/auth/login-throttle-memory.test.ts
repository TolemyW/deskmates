// T0: bounded memory must never discard a live failure budget or an active reservation.
import { describe, expect, it, vi } from "vitest";
import { LoginThrottle, type ThrottleTicket } from "./login-throttle.js";

function ticket(result: ReturnType<LoginThrottle["admit"]>): ThrottleTicket {
  if (!("ticket" in result)) throw new Error(`refused: ${result.retryAfterMs} ms`);
  return result.ticket;
}

// Inspect only the size: the regression concerns retained state, not just refusal responses.
function bucketCount(throttle: LoginThrottle): number {
  return throttle.size;
}

function fixture() {
  let now = 0;
  const throttle = new LoginThrottle(
    { windowMs: 60_000, perLoginName: 2, perAddress: 2 },
    () => new Date(now),
  );
  return {
    throttle,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function fill(throttle: LoginThrottle, count = 5000): void {
  for (let i = 0; i < count; i++) ticket(throttle.admit(`user-${i}`, `addr-${i}`)).failed();
}

describe("login throttle memory bounds", () => {
  it("does not allocate for probes or fresh names refused by a blocked address", () => {
    const { throttle } = fixture();
    for (let i = 0; i < 20_000; i++) expect(throttle.retryAfterMs(`probe-${i}`, "a")).toBe(0);
    expect(bucketCount(throttle)).toBe(0);
    ticket(throttle.admit("alice", "a")).failed();
    ticket(throttle.admit("bob", "a")).failed();
    const size = bucketCount(throttle);
    for (let i = 0; i < 20_000; i++) {
      expect(throttle.admit(`refused-${i}`, "a")).toEqual({ retryAfterMs: 60_000 });
    }
    expect(bucketCount(throttle)).toBe(size);
  });

  it("caps fresh-key spray without evicting live failures, then reclaims expired windows", () => {
    const { throttle, advance } = fixture();
    fill(throttle);
    expect(bucketCount(throttle)).toBe(10_000);
    expect(throttle.retryAfterMs("new", "new")).toBe(1000);
    expect(throttle.admit("new", "new")).toEqual({ retryAfterMs: 1000 });
    // Existing keys still work at capacity, with the original failure budget intact.
    ticket(throttle.admit("user-0", "addr-0")).failed();
    expect(throttle.admit("user-0", "addr-0")).toEqual({ retryAfterMs: 60_000 });
    expect(bucketCount(throttle)).toBe(10_000);
    advance(60_000);
    const fresh = ticket(throttle.admit("new", "new"));
    expect(bucketCount(throttle)).toBe(2);
    fresh.succeeded();
    expect(bucketCount(throttle)).toBe(0);
  });

  it("reserves both new keys atomically when only one slot remains", () => {
    const { throttle } = fixture();
    fill(throttle, 4999);
    ticket(throttle.admit("extra", "addr-0")).failed();
    expect(bucketCount(throttle)).toBe(9999);
    expect(throttle.admit("new", "new")).toEqual({ retryAfterMs: 1000 });
    expect(bucketCount(throttle)).toBe(9999);
    ticket(throttle.admit("extra", "one-new-address")).released();
    expect(bucketCount(throttle)).toBe(9999);
  });

  it("keeps pending tickets across expiration and capacity pressure, including late settlement", () => {
    const { throttle, advance } = fixture();
    const first = ticket(throttle.admit("pending", "pending"));
    const second = ticket(throttle.admit("pending", "pending"));
    fill(throttle, 4999);
    advance(60_000);
    // Pruning frees expired failures, but not the active pair of reservations.
    ticket(throttle.admit("fresh", "fresh")).released();
    expect(bucketCount(throttle)).toBe(2);
    expect(throttle.admit("pending", "pending")).toEqual({ retryAfterMs: 1000 });
    first.failed();
    first.released(); // A ticket still settles exactly once after expiration.
    expect(throttle.admit("pending", "pending")).toEqual({ retryAfterMs: 1000 });
    second.failed();
    expect(throttle.admit("pending", "pending")).toEqual({ retryAfterMs: 60_000 });
    advance(60_000);
    ticket(throttle.admit("pending", "pending")).succeeded();
    expect(bucketCount(throttle)).toBe(0);
  });

  it("bounds entirely pending reservations and frees capacity on release or success", () => {
    const { throttle, advance } = fixture();
    const pending = Array.from({ length: 5000 }, (_, i) =>
      ticket(throttle.admit(`user-${i}`, `addr-${i}`)),
    );
    advance(60_000);
    expect(throttle.admit("new", "new")).toEqual({ retryAfterMs: 1000 });
    expect(bucketCount(throttle)).toBe(10_000);
    pending[0]?.released();
    ticket(throttle.admit("new", "new")).succeeded();
    for (const attempt of pending) attempt.released();
    expect(bucketCount(throttle)).toBe(0);
  });

  it("a success preserves the address failure count", () => {
    const { throttle } = fixture();
    ticket(throttle.admit("alice", "a")).failed();
    const success = ticket(throttle.admit("alice", "b"));
    const other = ticket(throttle.admit("bob", "a"));
    success.succeeded();
    other.failed();
    expect(throttle.admit("alice", "a")).toEqual({ retryAfterMs: 60_000 });
    ticket(throttle.admit("alice", "b")).succeeded();
  });
  it("limits reclamation scans during a refusal burst without delaying freed capacity", () => {
    const { throttle, advance } = fixture();
    const pending = Array.from({ length: 5000 }, (_, i) =>
      ticket(throttle.admit(`user-${i}`, `addr-${i}`)),
    );
    const buckets = (throttle as unknown as { buckets: Map<string, unknown> }).buckets;
    const scans = vi.spyOn(buckets, Symbol.iterator);
    for (let i = 0; i < 1000; i++) {
      expect(throttle.admit(`new-${i}`, "new")).toEqual({ retryAfterMs: 1000 });
    }
    expect(scans).toHaveBeenCalledTimes(1);
    advance(1000);
    expect(throttle.admit("new", "new")).toEqual({ retryAfterMs: 1000 });
    expect(scans).toHaveBeenCalledTimes(2);
    pending[0]?.released();
    ticket(throttle.admit("new", "new")).succeeded();
    expect(scans).toHaveBeenCalledTimes(2);
    for (const attempt of pending) attempt.released();
    expect(bucketCount(throttle)).toBe(0);
  });
  it("a success keeps other pending attempts on the same login name", () => {
    const { throttle } = fixture();
    const first = ticket(throttle.admit("alice", "a"));
    const second = ticket(throttle.admit("alice", "b"));
    first.succeeded();
    const third = ticket(throttle.admit("alice", "c"));
    expect(throttle.admit("alice", "d")).toEqual({ retryAfterMs: 1000 });
    second.released();
    third.succeeded();
    expect(bucketCount(throttle)).toBe(0);
  });
  it("keeps a blocked name's live budget under a configured small cap", () => {
    const throttle = new LoginThrottle(
      { windowMs: 60_000, perLoginName: 2, perAddress: 2, maxKeys: 4 },
      () => new Date(0),
    );
    ticket(throttle.admit("alice", "a")).failed();
    ticket(throttle.admit("alice", "a")).failed();
    ticket(throttle.admit("bob", "b")).failed();
    expect(throttle.admit("carol", "c")).toEqual({ retryAfterMs: 1000 });
    expect(throttle.admit("alice", "a")).toEqual({ retryAfterMs: 60_000 });
    expect(throttle.size).toBe(4);
  });

  it("refuses a new pair when a configured small cap contains only pending tickets", () => {
    const throttle = new LoginThrottle(
      { windowMs: 60_000, perLoginName: 2, perAddress: 2, maxKeys: 2 },
      () => new Date(0),
    );
    const pending = ticket(throttle.admit("alice", "a"));
    expect(throttle.admit("bob", "b")).toEqual({ retryAfterMs: 1000 });
    expect(throttle.size).toBe(2);
    pending.released();
    ticket(throttle.admit("bob", "b")).succeeded();
    expect(throttle.size).toBe(0);
  });
});
