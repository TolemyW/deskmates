// T0: the shared display helpers format through Intl in the active locale (issue #23, decision
// 3). English output is what it was before localization; another locale changes dates, units
// and number punctuation.
import {
  RUN_ERROR_DEADLINE,
  RUN_ERROR_NO_REPLY,
  RUN_ERROR_TURN_BUDGET,
  UI_LOCALES,
} from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeRunError,
  formatCost,
  formatDateTime,
  formatDay,
  formatDuration,
  formatRelative,
} from "./format.js";
import { createI18n, englishI18n, setCurrentI18n } from "./i18n/intl.js";

const NOW = new Date("2026-09-21T12:00:00.000Z").getTime();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

afterEach(() => setCurrentI18n(englishI18n()));

describe("in English", () => {
  it("keeps the compact relative times", () => {
    expect(formatRelative(ago(10_000), NOW)).toBe("just now");
    expect(formatRelative(ago(5 * 60_000), NOW)).toBe("5m");
    expect(formatRelative(ago(2 * 3_600_000), NOW)).toBe("2h");
    expect(formatRelative(ago(3 * 86_400_000), NOW)).toBe("3d");
    expect(formatRelative("2026-09-01T12:00:00.000Z", NOW)).toBe("Sep 1");
  });

  it("keeps durations, costs, day labels and run errors", () => {
    expect(formatDuration("2026-09-21T12:00:00.000Z", "2026-09-21T12:00:00.250Z")).toBe("250 ms");
    expect(formatDuration("2026-09-21T12:00:00.000Z", "2026-09-21T12:00:01.500Z")).toBe("1.5 s");
    expect(formatDuration("2026-09-21T12:00:00.000Z", "2026-09-21T12:02:05.000Z")).toBe(
      "2 min 5 s",
    );
    expect(formatCost(null)).toBe("unpriced");
    expect(formatCost(0.01234)).toBe("$0.0123");
    expect(formatCost(1234.5)).toBe("$1234.5000");
    const now = new Date(NOW);
    expect(formatDay(new Date(NOW).toISOString(), now)).toBe("Today");
    expect(formatDay(ago(86_400_000), now)).toBe("Yesterday");
    expect(describeRunError(RUN_ERROR_NO_REPLY)).toBe(
      `No reply: the run was woken by a must-reply message and ended without replying (${RUN_ERROR_NO_REPLY}).`,
    );
    expect(describeRunError(RUN_ERROR_DEADLINE)).toBe(
      `Deadline passed: the conversation's deadline passed before the run ended (${RUN_ERROR_DEADLINE}).`,
    );
    expect(describeRunError(RUN_ERROR_TURN_BUDGET)).toBe(
      `Turn budget reached: the conversation hit its bot-message limit, paused, and cancelled this queued run (${RUN_ERROR_TURN_BUDGET}); a human message resumes it.`,
    );
    expect(describeRunError("anything else")).toBe("anything else");
  });

  it("gives every Gateway-recorded run error a sentence in every locale, code kept", () => {
    for (const locale of UI_LOCALES) {
      setCurrentI18n(createI18n(locale));
      for (const code of [RUN_ERROR_NO_REPLY, RUN_ERROR_DEADLINE, RUN_ERROR_TURN_BUDGET]) {
        const text = describeRunError(code);
        expect(text, `${locale} ${code}`).not.toBe(code);
        expect(text, `${locale} ${code}`).toContain(code);
      }
    }
  });

  it("formats a date and time the way the locale writes them", () => {
    const iso = "2026-09-21T10:00:00.000Z";
    expect(formatDateTime(iso)).toBe(new Date(iso).toLocaleString("en"));
  });
});

describe("in another locale", () => {
  it("uses the locale's units, dates and number punctuation", () => {
    setCurrentI18n(createI18n("zh-CN"));
    expect(formatRelative(ago(5 * 60_000), NOW)).toBe("5分钟");
    expect(formatRelative("2026-09-01T12:00:00.000Z", NOW)).toBe("9月1日");
    const iso = "2026-09-21T10:00:00.000Z";
    expect(formatDateTime(iso)).toBe(new Date(iso).toLocaleString("zh-CN"));
    setCurrentI18n(createI18n("es"));
    expect(formatDuration("2026-09-21T12:00:00.000Z", "2026-09-21T12:00:01.500Z")).toContain("1,5");
    expect(formatCost(0.01234)).toBe(
      (0.01234).toLocaleString("es", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 4,
        maximumFractionDigits: 4,
        useGrouping: false,
      }),
    );
  });
});
