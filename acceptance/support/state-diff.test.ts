// T0 for the client-side side-effect invariant of benchmark §5. No Docker, no network, no model:
// state-diff.ts is a pure function over two `/api/state` snapshots. The fixtures are shaped like
// the golden site's StateView (keyed `orders`, a `session` subtree, `updated_at` timestamps) but
// are literals here, so a change to the site's seed cannot make this test lie.

import { describe, expect, it } from "vitest";
import { allowedBy, diffPaths, unexpectedChanges } from "./state-diff.js";

interface Order {
  id: string;
  customer: string;
  sku: string;
  qty: number;
  updated_at: string;
}

interface StateFixture {
  orders: Record<string, Order>;
  customers: Record<string, { id: string; name: string }>;
  session: { id: string; email: string; mfa_passed: boolean };
  counters: { active_sessions: number };
}

const O2001: Order = { id: "O-2001", customer: "C-0001", sku: "SKU-1", qty: 1, updated_at: "t0" };
const O2002: Order = { id: "O-2002", customer: "C-0002", sku: "SKU-3", qty: 2, updated_at: "t0" };
/** The order deskbench S11 would create: a key the seed does not have. */
const O2051: Order = { id: "O-2051", customer: "C-0002", sku: "SKU-7", qty: 1, updated_at: "t1" };

const seed: StateFixture = {
  orders: { "O-2001": O2001, "O-2002": O2002 },
  customers: { "C-0001": { id: "C-0001", name: "Vega Freight" } },
  session: { id: "s-1", email: "ops@example.test", mfa_passed: false },
  counters: { active_sessions: 1 },
};

/** `seed` with one top-level collection replaced; every fixture below is built this way. */
function withState(patch: Partial<StateFixture>): StateFixture {
  return { ...seed, ...patch };
}

describe("diffPaths", () => {
  it("reports nothing for identical snapshots", () => {
    expect(diffPaths(seed, withState({}))).toEqual([]);
  });

  it("ignores the session subtree and every updated_at field", () => {
    const after = withState({
      session: { id: "s-2", email: "someone.else@example.test", mfa_passed: true },
      orders: { "O-2001": { ...O2001, updated_at: "t9" }, "O-2002": O2002 },
    });
    expect(diffPaths(seed, after)).toEqual([]);
  });

  it("ignores the humanCheck subtree, the other side of the site's session report", () => {
    const before = { ...seed, humanCheck: { enabled: true, code: "K7QM2X", verifiedSessions: 0 } };
    const after = { ...seed, humanCheck: { enabled: true, code: "R4DHP9", verifiedSessions: 1 } };
    expect(diffPaths(before, after)).toEqual([]);
    // A task that may add an order and nothing else still passes once a human verified a session.
    expect(unexpectedChanges(before, after, ["orders.+"])).toEqual([]);
  });

  it("reports an added key, a modified value and a removed key as dotted paths", () => {
    const after = withState({
      orders: { "O-2001": O2001, "O-2002": { ...O2002, qty: 99 }, "O-2051": O2051 },
      customers: {},
    });
    // A subtree that appeared or vanished is one path, not one per leaf: the walk stops as soon
    // as one side is not an object.
    expect(diffPaths(seed, after)).toEqual([
      "customers.C-0001",
      "orders.O-2002.qty",
      "orders.O-2051",
    ]);
  });
});

describe("allowedBy", () => {
  it("covers only keys absent from the seed under a `collection.+` entry", () => {
    expect(allowedBy("orders.O-2051", "orders.+", seed)).toBe(true);
    expect(allowedBy("orders.O-2051.qty", "orders.+", seed)).toBe(true);
    expect(allowedBy("orders.O-2002.qty", "orders.+", seed)).toBe(false);
    expect(allowedBy("customers.C-0009", "orders.+", seed)).toBe(false);
  });

  it("covers a path and everything below it for a plain prefix entry", () => {
    expect(allowedBy("counters", "counters", seed)).toBe(true);
    expect(allowedBy("counters.active_sessions", "counters", seed)).toBe(true);
    expect(allowedBy("counters_other", "counters", seed)).toBe(false);
  });
});

describe("unexpectedChanges", () => {
  it("allows a new order under `orders.+` and flags a modified existing one", () => {
    const added = withState({ orders: { "O-2001": O2001, "O-2002": O2002, "O-2051": O2051 } });
    expect(unexpectedChanges(seed, added, ["orders.+"])).toEqual([]);

    const alsoModified = withState({
      orders: { "O-2001": O2001, "O-2002": { ...O2002, qty: 99 }, "O-2051": O2051 },
    });
    expect(unexpectedChanges(seed, alsoModified, ["orders.+"])).toEqual(["orders.O-2002.qty"]);
  });

  it("flags a removed key: `orders.+` covers additions, not deletions", () => {
    const removed = withState({ orders: { "O-2001": O2001 } });
    expect(unexpectedChanges(seed, removed, ["orders.+"])).toEqual(["orders.O-2002"]);
  });

  it("flags any change when allowed_paths is empty, and still ignores session and updated_at", () => {
    // What S01 asserts: a read-only task may open a session and touch timestamps, nothing else.
    const readOnly = withState({
      session: { id: "s-2", email: "ops@example.test", mfa_passed: true },
      orders: { "O-2001": O2001, "O-2002": { ...O2002, updated_at: "t9" } },
    });
    expect(unexpectedChanges(seed, readOnly, [])).toEqual([]);

    const wrote = withState({ counters: { active_sessions: 2 } });
    expect(unexpectedChanges(seed, wrote, [])).toEqual(["counters.active_sessions"]);
  });
});
