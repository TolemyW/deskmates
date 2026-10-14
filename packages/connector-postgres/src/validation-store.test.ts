// T0: validations live in memory for the TTL. A submit after the TTL hears "stale", not
// "missing", for one more TTL; after that the entry is swept and the id is unknown.

import { describe, expect, it } from "vitest";
import { ValidationStore } from "./validation-store.js";

const entry = (validationId: string) => ({
  validationId,
  contentHash: "a".repeat(64),
  valid: true,
  effect: "read" as const,
  summary: "s",
  errors: [],
});

describe("ValidationStore", () => {
  it("returns a live validation within the TTL", () => {
    let now = 1_000_000;
    const store = new ValidationStore(900, () => now);
    store.put(entry("v1"));
    now += 899_000;
    const got = store.lookup("v1");
    expect(got.status).toBe("live");
    expect(got.status === "live" && got.validation.validationId).toBe("v1");
  });

  it("reports stale at the TTL and missing once swept", () => {
    let now = 1_000_000;
    const store = new ValidationStore(900, () => now);
    store.put(entry("v1"));
    now += 900_000;
    expect(store.lookup("v1").status).toBe("stale");
    now += 900_000;
    store.put(entry("v2"));
    expect(store.lookup("v1").status).toBe("missing");
    expect(store.lookup("v2").status).toBe("live");
  });

  it("does not know an id it never issued", () => {
    expect(new ValidationStore(900).lookup("nope").status).toBe("missing");
  });
});
