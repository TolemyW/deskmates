import { expect, it } from "vitest";
import { assertExpectedMemoryVersion } from "./versions.js";

it("rejects a stale memory draft while allowing a matching or legacy version", () => {
  expect(() => assertExpectedMemoryVersion(4, 3)).toThrow(/changed since you opened/);
  expect(() => assertExpectedMemoryVersion(4, 4)).not.toThrow();
  expect(() => assertExpectedMemoryVersion(4)).not.toThrow();
});
