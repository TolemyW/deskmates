// T0: `createApiClient` is only a composition. The domain modules and their wire goldens are found
// at runtime (no central list here), and the test fails when two domains define the same method,
// when a domain is missing from `client.ts`, or when a method is not pinned by exactly one golden.

import { describe, expect, it } from "vitest";
import { createHttpTransport } from "../platform/http-transport.js";
import { createApiClient } from "./client.js";

/** Every `src/features/<f>/api.ts` and `src/api/*-api.ts` module, by path. */
const MODULES = {
  ...import.meta.glob<Record<string, unknown>>("../features/*/api.ts", { eager: true }),
  ...import.meta.glob<Record<string, unknown>>("./*-api.ts", { eager: true }),
};

/** Every feature's `__golden__/api.golden.txt` and every `src/api/__golden__/*-api.golden.txt`. */
const GOLDENS = {
  ...import.meta.glob<string>("../features/*/__golden__/api.golden.txt", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
  ...import.meta.glob<string>("./__golden__/*-api.golden.txt", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
};

function domainMethods(): Map<string, string> {
  const t = createHttpTransport();
  const owner = new Map<string, string>();
  for (const [path, mod] of Object.entries(MODULES)) {
    for (const [name, create] of Object.entries(mod)) {
      if (!/^create\w+Api$/.test(name) || typeof create !== "function") continue;
      for (const method of Object.keys(create(t) as object)) {
        expect(owner.get(method), `${method} is in ${owner.get(method)} and ${path}`).toBe(
          undefined,
        );
        owner.set(method, path);
      }
    }
  }
  return owner;
}

describe("api client composition", () => {
  it("finds the domain modules", () => {
    expect(Object.keys(MODULES).length).toBeGreaterThan(1);
  });

  it("gives every method exactly one owning domain and composes all of them", () => {
    const owner = domainMethods();
    expect(Object.keys(createApiClient()).sort()).toEqual([...owner.keys()].sort());
  });

  it("pins every ApiClient method in exactly one domain's wire golden", () => {
    const pinnedBy = new Map<string, string>();
    for (const [path, text] of Object.entries(GOLDENS)) {
      for (const method of Object.keys(JSON.parse(text) as object)) {
        expect(pinnedBy.get(method), `${method} is in ${pinnedBy.get(method)} and ${path}`).toBe(
          undefined,
        );
        pinnedBy.set(method, path);
      }
    }
    expect([...pinnedBy.keys()].sort()).toEqual(Object.keys(createApiClient()).sort());
  });
});
