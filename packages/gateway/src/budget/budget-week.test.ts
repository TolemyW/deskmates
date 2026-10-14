// T0: the budget week starts Monday 00:00 UTC (ADR-0032 decision 2).

import { weekEndUtc, weekStartUtc } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";

const iso = (d: Date) => d.toISOString();

describe("budget week (ADR-0032 decision 2)", () => {
  it("starts on Monday 00:00 UTC", () => {
    // 2026-10-12 is a Monday.
    expect(iso(weekStartUtc(new Date("2026-10-12T00:00:00.000Z")))).toBe(
      "2026-10-12T00:00:00.000Z",
    );
    expect(iso(weekStartUtc(new Date("2026-10-13T15:30:00.000Z")))).toBe(
      "2026-10-12T00:00:00.000Z",
    );
    expect(iso(weekEndUtc(new Date("2026-10-13T15:30:00.000Z")))).toBe("2026-10-19T00:00:00.000Z");
  });

  it("puts Sunday 23:59 UTC in the week that began the Monday before", () => {
    expect(iso(weekStartUtc(new Date("2026-10-18T23:59:59.999Z")))).toBe(
      "2026-10-12T00:00:00.000Z",
    );
  });

  it("ignores local time zones: an offset timestamp is read as its UTC instant", () => {
    // Monday 01:00 in UTC+02:00 is Sunday 23:00 UTC: still the previous week.
    expect(iso(weekStartUtc(new Date("2026-10-19T01:00:00.000+02:00")))).toBe(
      "2026-10-12T00:00:00.000Z",
    );
  });
});
