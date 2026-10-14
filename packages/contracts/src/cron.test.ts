// T0: the five-field cron grammar, timezone-aware matching and the next-fire search.

import { describe, expect, it } from "vitest";
import { cronMatches, nextCronFire, parseCron } from "./cron.js";
import { isDeskmatesError } from "./errors.js";

/** A UTC instant, so the default-zone cases below pin the zone explicitly. */
function at(iso: string): Date {
  return new Date(iso);
}

describe("parseCron", () => {
  it("accepts every-five-minutes and expands the step", () => {
    const parsed = parseCron("*/5 * * * *");
    expect([...parsed.minute]).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
    expect(parsed.hour.size).toBe(24);
    expect(parsed.dayOfMonthRestricted).toBe(false);
    expect(parsed.dayOfWeekRestricted).toBe(false);
  });

  it("accepts lists, ranges and a range with a step", () => {
    expect([...parseCron("1,2 1-5 * * *").minute]).toEqual([1, 2]);
    expect([...parseCron("1,2 1-5 * * *").hour]).toEqual([1, 2, 3, 4, 5]);
    expect([...parseCron("1-10/2 * * * *").minute]).toEqual([1, 3, 5, 7, 9]);
  });

  it("treats day-of-week 0 and 7 as Sunday", () => {
    expect([...parseCron("0 0 * * 7").dayOfWeek]).toEqual([0]);
    expect([...parseCron("0 0 * * 0").dayOfWeek]).toEqual([0]);
    expect([...parseCron("0 0 * * 6-7").dayOfWeek]).toEqual([0, 6]);
  });

  it("rejects a bad field count, a bad range, a step of zero and an out-of-range value", () => {
    for (const bad of ["* * * *", "* * * * * *", "", "5-1 * * * *", "*/0 * * * *", "60 * * * *"]) {
      let thrown: unknown;
      try {
        parseCron(bad);
      } catch (err) {
        thrown = err;
      }
      expect(isDeskmatesError(thrown), `expected ${bad || "<empty>"} to be rejected`).toBe(true);
      expect(isDeskmatesError(thrown) && thrown.code).toBe("validation");
    }
  });
});

describe("cronMatches", () => {
  it("matches a whole minute regardless of seconds", () => {
    expect(cronMatches("*/5 * * * *", at("2026-09-22T10:05:00Z"), "UTC")).toBe(true);
    expect(cronMatches("*/5 * * * *", at("2026-09-22T10:05:47.123Z"), "UTC")).toBe(true);
    expect(cronMatches("*/5 * * * *", at("2026-09-22T10:06:00Z"), "UTC")).toBe(false);
  });

  it("matches weekdays at 09:00 in the given zone, not the process zone", () => {
    // 2026-09-22 is a Tuesday. 09:00 in Asia/Shanghai is 01:00Z.
    expect(cronMatches("0 9 * * 1-5", at("2026-09-22T01:00:00Z"), "Asia/Shanghai")).toBe(true);
    expect(cronMatches("0 9 * * 1-5", at("2026-09-22T09:00:00Z"), "Asia/Shanghai")).toBe(false);
    // 2026-09-20 is a Sunday.
    expect(cronMatches("0 9 * * 1-5", at("2026-09-20T09:00:00Z"), "UTC")).toBe(false);
    expect(cronMatches("0 9 * * 7", at("2026-09-20T09:00:00Z"), "UTC")).toBe(true);
  });

  it("matches the first of the month at 02:30", () => {
    expect(cronMatches("30 2 1 * *", at("2026-10-01T02:30:00Z"), "UTC")).toBe(true);
    expect(cronMatches("30 2 1 * *", at("2026-10-02T02:30:00Z"), "UTC")).toBe(false);
  });

  it("ORs a restricted day-of-month with a restricted day-of-week", () => {
    // Either the 1st or a Sunday.
    expect(cronMatches("0 0 1 * 0", at("2026-10-01T00:00:00Z"), "UTC")).toBe(true);
    expect(cronMatches("0 0 1 * 0", at("2026-10-04T00:00:00Z"), "UTC")).toBe(true);
    expect(cronMatches("0 0 1 * 0", at("2026-10-05T00:00:00Z"), "UTC")).toBe(false);
  });

  it("rejects an unknown time zone as a validation error", () => {
    expect(() => cronMatches("* * * * *", at("2026-09-22T10:00:00Z"), "Mars/Olympus")).toThrow(
      /time zone/,
    );
  });
});

describe("nextCronFire", () => {
  it("returns the next whole minute that matches, strictly after `after`", () => {
    expect(nextCronFire("*/5 * * * *", at("2026-09-22T10:05:00Z"), "UTC")?.toISOString()).toBe(
      "2026-09-22T10:10:00.000Z",
    );
    expect(nextCronFire("*/5 * * * *", at("2026-09-22T10:04:30Z"), "UTC")?.toISOString()).toBe(
      "2026-09-22T10:05:00.000Z",
    );
    expect(nextCronFire("30 2 1 * *", at("2026-10-01T02:30:00Z"), "UTC")?.toISOString()).toBe(
      "2026-11-01T02:30:00.000Z",
    );
  });

  // Walks every minute of a year: ~1.6 s alone, over the 5 s default on a loaded or 2-core host.
  it("returns undefined for a date that never comes within 366 days", { timeout: 30_000 }, () => {
    expect(nextCronFire("0 0 30 2 *", at("2026-09-22T10:00:00Z"), "UTC")).toBeUndefined();
  });
});
