// T0, ADR-0011 amendment 4 A25: which current notes need revalidation, and why.

import { describe, expect, it } from "vitest";
import { type FreshnessInput, memoryFreshness } from "./memory-freshness.js";

const NOW = new Date("2026-10-14T00:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

const note = (patch: Partial<FreshnessInput> = {}): FreshnessInput => ({
  scope: "workspace",
  kind: "note",
  trust: "trusted",
  tombstoned: false,
  observedAt: daysAgo(1),
  effectiveAt: daysAgo(1),
  ...patch,
});

describe("memoryFreshness", () => {
  const cases: [string, FreshnessInput, string[]][] = [
    ["a fresh workspace fact", note(), []],
    ["a workspace fact just inside 90 days", note({ effectiveAt: daysAgo(89) }), []],
    ["a workspace fact past 90 days", note({ effectiveAt: daysAgo(91) }), ["age"]],
    ["a bot note at 120 days", note({ scope: "bot", effectiveAt: daysAgo(120) }), []],
    ["a bot note past 180 days", note({ scope: "bot", effectiveAt: daysAgo(181) }), ["age"]],
    [
      "an old fact a human confirmed recently",
      note({ effectiveAt: daysAgo(200), lastConfirmedAt: daysAgo(3) }),
      [],
    ],
    [
      "a TTL that ran out",
      note({ observedAt: daysAgo(10), ttlSeconds: 5 * 86_400 }),
      ["ttl_expired"],
    ],
    [
      "a TTL running out within 7 days",
      note({ observedAt: daysAgo(10), ttlSeconds: 15 * 86_400 }),
      ["ttl_expiring"],
    ],
    ["a TTL far away", note({ observedAt: daysAgo(1), ttlSeconds: 30 * 86_400 }), []],
    ["a short TTL in its first half", note({ observedAt: daysAgo(1), ttlSeconds: 5 * 86_400 }), []],
    [
      "a short TTL in its second half",
      note({ observedAt: daysAgo(3), ttlSeconds: 5 * 86_400 }),
      ["ttl_expiring"],
    ],
    [
      "an untrusted value that closed a trusted one",
      note({ trust: "untrusted", replacedTrusted: true }),
      ["replaced_trusted"],
    ],
    ["a trusted value that closed a trusted one", note({ replacedTrusted: true }), []],
    [
      "every reason at once, most urgent first",
      note({
        trust: "untrusted",
        replacedTrusted: true,
        observedAt: daysAgo(100),
        effectiveAt: daysAgo(100),
        ttlSeconds: 86_400,
      }),
      ["replaced_trusted", "ttl_expired", "age"],
    ],
    ["a task note", note({ scope: "task", effectiveAt: daysAgo(400) }), []],
    ["an episode", note({ kind: "episode", effectiveAt: daysAgo(400) }), []],
    ["a candidate", note({ kind: "candidate", effectiveAt: daysAgo(400) }), []],
    ["a distilled note", note({ episodeId: "ep_1", effectiveAt: daysAgo(400) }), []],
    ["a forgotten note", note({ tombstoned: true, effectiveAt: daysAgo(400) }), []],
    [
      "a superseded note",
      note({ invalidAt: daysAgo(2), effectiveAt: daysAgo(400), ttlSeconds: 1 }),
      [],
    ],
  ];
  for (const [name, input, expected] of cases)
    it(name, () => expect(memoryFreshness(input, NOW)).toEqual(expected));

  it("reads the effective time before the observation time", () => {
    expect(
      memoryFreshness(note({ observedAt: daysAgo(300), effectiveAt: daysAgo(2) }), NOW),
    ).toEqual([]);
  });

  it("takes the horizon from the policy", () => {
    const policy = { workspaceDays: 10, botDays: 20, expiringDays: 1 };
    expect(memoryFreshness(note({ effectiveAt: daysAgo(11) }), NOW, policy)).toEqual(["age"]);
  });
});
