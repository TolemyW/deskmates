// T0: the operator route families are one sorted list (issue #53), so a new domain adds one line
// where nobody else is appending. Route coverage itself is in `route-policy.test.ts`.

import { describe, expect, it } from "vitest";
import { OPERATOR_ROUTE_FAMILIES } from "./routes.js";

describe("operator route families", () => {
  it("are listed once each, sorted by name", () => {
    const names = OPERATOR_ROUTE_FAMILIES.map(([name]) => name);
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
  });
});
