import { describe, expect, it } from "vitest";
import { PAGE_LIMIT_MAX, parsePageLimit, parsePageOffset } from "./pagination.js";

const policy = { default: 25, max: PAGE_LIMIT_MAX };

describe("parsePageLimit", () => {
  it("defaults an absent or empty limit to the surface default", () => {
    expect(parsePageLimit(undefined, policy)).toEqual({ ok: true, limit: 25 });
    expect(parsePageLimit("", policy)).toEqual({ ok: true, limit: 25 });
  });

  it("accepts integers from 1 to the surface maximum, as strings or numbers", () => {
    expect(parsePageLimit("1", policy)).toEqual({ ok: true, limit: 1 });
    expect(parsePageLimit("100", policy)).toEqual({ ok: true, limit: 100 });
    expect(parsePageLimit(40, policy)).toEqual({ ok: true, limit: 40 });
  });

  it("refuses a limit above the maximum instead of clamping it", () => {
    expect(parsePageLimit("101", policy)).toEqual({ ok: false, field: "limit" });
    expect(parsePageLimit("11", { default: 10, max: 10 })).toEqual({ ok: false, field: "limit" });
  });

  it.each(["0", "-1", "2.5", "ten", "1e2", " 5", [5], {}])("refuses %j", (raw) => {
    expect(parsePageLimit(raw, policy)).toEqual({ ok: false, field: "limit" });
  });
});

describe("parsePageOffset", () => {
  it("defaults to zero and accepts non-negative integers", () => {
    expect(parsePageOffset(undefined)).toEqual({ ok: true, offset: 0 });
    expect(parsePageOffset("0")).toEqual({ ok: true, offset: 0 });
    expect(parsePageOffset("75")).toEqual({ ok: true, offset: 75 });
  });

  it.each(["-25", "2.5", "x", 1.5])("refuses %j", (raw) => {
    expect(parsePageOffset(raw)).toEqual({ ok: false, field: "offset" });
  });
});
