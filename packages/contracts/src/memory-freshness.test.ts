// T0, ADR-0011 amendment 4 A25: which current notes need revalidation, and why.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEMORY_FRESHNESS_POLICY,
  type FreshnessInput,
  decidedByModelRun,
  isModelDecision,
  memoryFreshness,
  parseMemoryRecheckReply,
} from "./memory-freshness.js";

const NOW = new Date("2026-10-14T00:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

const note = (patch: Partial<FreshnessInput> = {}): FreshnessInput => ({
  scope: "workspace",
  kind: "note",
  trust: "trusted",
  tombstoned: false,
  observedAt: daysAgo(0.5),
  effectiveAt: daysAgo(0.5),
  ...patch,
});

describe("memoryFreshness", () => {
  const cases: [string, FreshnessInput, string[]][] = [
    ["a fresh workspace fact", note(), []],
    // Owner ruling 2026-10-14: a 1-day horizon for workspace and bot notes (was 90 and 180).
    ["a workspace fact just inside 1 day", note({ effectiveAt: daysAgo(0.9) }), []],
    ["a workspace fact past 1 day", note({ effectiveAt: daysAgo(1.1) }), ["age"]],
    ["a bot note just inside 1 day", note({ scope: "bot", effectiveAt: daysAgo(0.9) }), []],
    ["a bot note past 1 day", note({ scope: "bot", effectiveAt: daysAgo(1.1) }), ["age"]],
    [
      "an old fact confirmed (by a human or the model) within the day",
      note({ effectiveAt: daysAgo(200), lastConfirmedAt: daysAgo(0.5) }),
      [],
    ],
    [
      "a TTL that ran out",
      note({ observedAt: daysAgo(10), ttlSeconds: 5 * 86_400 }),
      ["ttl_expired"],
    ],
    [
      "a TTL running out within 7 days",
      note({ observedAt: daysAgo(10), effectiveAt: daysAgo(0.5), ttlSeconds: 15 * 86_400 }),
      ["ttl_expiring"],
    ],
    ["a TTL far away", note({ observedAt: daysAgo(0.5), ttlSeconds: 30 * 86_400 }), []],
    [
      "a short TTL in its first half",
      note({ observedAt: daysAgo(0.5), ttlSeconds: 5 * 86_400 }),
      [],
    ],
    [
      "a short TTL in its second half",
      note({ observedAt: daysAgo(3), effectiveAt: daysAgo(0.5), ttlSeconds: 5 * 86_400 }),
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
      memoryFreshness(note({ observedAt: daysAgo(300), effectiveAt: daysAgo(0.5) }), NOW),
    ).toEqual([]);
  });

  it("defaults to a 1-day horizon for both scopes", () => {
    expect(DEFAULT_MEMORY_FRESHNESS_POLICY).toEqual({
      workspaceDays: 1,
      botDays: 1,
      expiringDays: 7,
    });
  });

  it("parses recheck replies and drops what is not a verdict (A28)", () => {
    const long = "x".repeat(500);
    expect(
      parseMemoryRecheckReply(
        `\`\`\`json\n{"verdicts":[{"id":"a","verdict":"still_true","reason":" seen \\n today "},{"id":"b","verdict":"approve","reason":"x"},{"verdict":"unclear"},{"id":"c","verdict":"possibly_stale","reason":"${long}"},{"id":"d","verdict":"unclear"}]}\n\`\`\``,
      ),
    ).toEqual([
      { id: "a", verdict: "still_true", reason: "seen today" },
      { id: "c", verdict: "possibly_stale", reason: "x".repeat(200) },
      { id: "d", verdict: "unclear", reason: "" },
    ]);
    expect(parseMemoryRecheckReply("all true")).toBeUndefined();
    expect(parseMemoryRecheckReply('{"labels":[]}')).toBeUndefined();
    expect(decidedByModelRun("run_1")).toBe("model:run_1");
    expect(isModelDecision("model:run_1")).toBe(true);
    expect(isModelDecision("human:alice")).toBe(false);
  });

  it("takes the horizon from the policy", () => {
    const policy = { workspaceDays: 10, botDays: 20, expiringDays: 1 };
    expect(memoryFreshness(note({ effectiveAt: daysAgo(11) }), NOW, policy)).toEqual(["age"]);
  });
});

it("preserves bounded exact citations and drops malformed citation fields", () => {
  const parse = (evidence: unknown) =>
    parseMemoryRecheckReply(
      JSON.stringify({
        verdicts: [{ id: "mem_a", verdict: "still_true", reason: "fresh source", evidence }],
      }),
    )?.[0];
  expect(parse({ sourceId: "message:1", quote: "A direct factual quote." })?.evidence).toEqual({
    sourceId: "message:1",
    quote: "A direct factual quote.",
  });
  // A whole truncated source (500 characters plus the mark) is a legitimate quote.
  expect(
    parse({ sourceId: "message:1", quote: `${"x".repeat(500)}…` })?.evidence?.quote,
  ).toHaveLength(501);
  for (const evidence of [
    null,
    {},
    { sourceId: 42, quote: "fact" },
    { sourceId: "x", quote: " " },
    { sourceId: "x", quote: "x".repeat(601) },
  ])
    expect(parse(evidence)?.evidence).toBeUndefined();
});
