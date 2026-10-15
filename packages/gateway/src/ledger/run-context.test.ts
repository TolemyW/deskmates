// T0: per-run context metrics, computed on read from the ledger (M3 context plan, Phase 1).

import type { RunEvent, RunEventKind, RunId } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import type { RequestShape } from "../model-proxy/request-facts.js";
import type { ModelRequestRecord } from "./model-requests.js";
import { runContextMetrics } from "./run-context.js";

const RUN = "run_1" as RunId;
let seq = 0;

function event(kind: RunEventKind, payload: Record<string, unknown>, attempt = 1): RunEvent {
  seq += 1;
  return { runId: RUN, seq, attempt, kind, payload, ts: "t" };
}

function turn(input: number, cacheRead: number, cacheCreate = 0, attempt = 1): RunEvent {
  return event(
    "turn_usage",
    {
      model: "m",
      turn: seq,
      inputTokens: input,
      outputTokens: 1,
      cacheReadTokens: cacheRead,
      cacheCreateTokens: cacheCreate,
    },
    attempt,
  );
}

function request(
  attempt: number,
  systemSha256: string | null,
  requestKind: ModelRequestRecord["requestKind"] = "messages",
): ModelRequestRecord {
  return {
    runId: RUN,
    attempt,
    seq: 0,
    ts: "t",
    requestKind,
    model: "m",
    systemSha256,
    stream: true,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreateTokens: null,
    thinkingTokens: null,
    rewrittenFrom: null,
    refusal: null,
    servedModel: null,
  };
}

describe("runContextMetrics", () => {
  it("reports turns, window peak and p95, cache hit ratio, compactions and sections", () => {
    seq = 0;
    const events: RunEvent[] = [
      event("log", {
        source: "context",
        kind: "context_sections",
        sections: { soul: 10, memory: 0, diary: 5, knowledge: 0, guidance: 100 },
        systemPromptSha256: "a".repeat(64),
      }),
      // Windows: 1000, 2000, ..., 20000 (input + cache read + cache create).
      ...Array.from({ length: 20 }, (_, i) => turn(100 * (i + 1), 900 * (i + 1))),
      event("compact_boundary", { trigger: "auto", preTokens: 150000, postTokens: 9000 }),
      event("log", { source: "assistant", text: "not a context event" }),
      event(
        "log",
        {
          source: "context",
          kind: "context_sections",
          sections: { soul: 10, memory: 3, diary: 6, knowledge: 0, guidance: 100 },
          systemPromptSha256: "b".repeat(64),
          systemPromptStaticSha256: "c".repeat(64),
          systemPromptDynamicSha256: "d".repeat(64),
        },
        2,
      ),
      turn(50, 0, 50, 2),
    ];
    const m = runContextMetrics(events, [
      request(1, "x"),
      request(1, "x"),
      request(1, null, "count_tokens"),
      request(2, "y"),
    ]);
    expect(m.turns).toBe(21);
    expect(m.peakInputTokens).toBe(20000);
    // Nearest rank: the 20th of 21 sorted windows.
    expect(m.p95InputTokens).toBe(19000);
    const read = 900 * 210;
    const input = 100 * 210 + 50;
    expect(m.cacheHitRatio).toBeCloseTo(read / (read + input + 50), 12);
    expect(m.compactions).toEqual([
      { attempt: 1, seq: 22, trigger: "auto", preTokens: 150000, postTokens: 9000 },
    ]);
    // The latest attempt's assembly.
    expect(m.contextSections).toEqual({
      soul: 10,
      memory: 3,
      diary: 6,
      knowledge: 0,
      guidance: 100,
    });
    expect(m.systemPromptSha256).toBe("b".repeat(64));
    expect(m.systemPromptStaticSha256).toBe("c".repeat(64));
    expect(m.systemPromptDynamicSha256).toBe("d".repeat(64));
    expect(m.modelRequests).toEqual({
      count: 3,
      distinctSystemHashes: 2,
      changedWithinAttempt: false,
    });
  });

  it("flags a system prompt that changed inside one attempt", () => {
    const m = runContextMetrics([], [request(1, "x"), request(1, "y"), request(2, "y")]);
    expect(m.modelRequests.changedWithinAttempt).toBe(true);
  });

  it("reports unknowns as null on an empty run", () => {
    expect(runContextMetrics([], [])).toEqual({
      turns: 0,
      peakInputTokens: null,
      p95InputTokens: null,
      cacheHitRatio: null,
      compactions: [],
      contextSections: null,
      systemPromptSha256: null,
      maxContextTokens: null,
      systemPromptStaticSha256: null,
      systemPromptDynamicSha256: null,
      modelRequests: { count: 0, distinctSystemHashes: 0, changedWithinAttempt: false },
      contextUsage: { samples: 0, first: null, latest: null },
      sessionStarts: [],
      requestShapes: null,
    });
  });

  it("takes the context window from the latest init log, else from the run's RunEnded value", () => {
    const init = (maxContextTokens?: unknown) =>
      event("log", { source: "sdk", usageSessionFingerprint: "f", maxContextTokens });
    expect(runContextMetrics([init(180000)], []).maxContextTokens).toBe(180000);
    expect(runContextMetrics([init(100000), init(64000)], []).maxContextTokens).toBe(64000);
    expect(
      runContextMetrics([init(undefined)], [], { claudeCodeMaxContextTokens: 200000 })
        .maxContextTokens,
    ).toBe(200000);
    expect(runContextMetrics([init(0), init("1")], []).maxContextTokens).toBeNull();
  });

  it.each([undefined, null, -1, Number.NaN, "10"])(
    "keeps incomplete window coverage unknown (%s)",
    (inputTokens) => {
      const m = runContextMetrics(
        [
          turn(10, 90),
          event("turn_usage", { inputTokens, cacheReadTokens: 100, cacheCreateTokens: 0 }),
        ],
        [],
      );
      expect(m.turns).toBe(2);
      expect(m.peakInputTokens).toBeNull();
      expect(m.p95InputTokens).toBeNull();
      expect(m.cacheHitRatio).toBeNull();
    },
  );

  it("counts cache creation in the prompt window and cache-hit denominator", () => {
    const m = runContextMetrics([turn(10, 40, 50)], []);
    expect(m.peakInputTokens).toBe(100);
    expect(m.cacheHitRatio).toBe(0.4);
  });
});

// ADR-0023 amendment 5: the CLI's own context samples, session starts and request shapes.
describe("runContextMetrics, amendment 5", () => {
  const sample = (turnNo: number, total: number, detail = "summary", attempt = 1) =>
    event(
      "log",
      {
        source: "context",
        kind: "context_usage",
        detail,
        turn: turnNo,
        totalTokens: total,
        maxTokens: 200000,
        percentage: Math.round((total / 200000) * 100),
        categories: [{ name: "System tools", kind: "used", tokens: 12000 }],
      },
      attempt,
    );
  const shaped = (attempt: number, shape: Partial<RequestShape>): ModelRequestRecord => ({
    ...request(attempt, "a"),
    shape: {
      cacheControlBlocks: 2,
      systemBlocks: 2,
      systemChars: 4000,
      systemBlockHashes: ["b0", "b1"],
      toolsCount: 44,
      toolsChars: 90000,
      messagesCount: 3,
      ...shape,
    },
  });

  it("keeps the first and the latest context sample and ignores a warning", () => {
    seq = 0;
    const m = runContextMetrics(
      [
        sample(0, 40000, "full"),
        sample(1, 42000),
        event("log", { source: "context", kind: "context_usage", level: "warn", error: "x" }),
        sample(2, 44000),
      ],
      [],
    );
    expect(m.contextUsage?.samples).toBe(3);
    expect(m.contextUsage?.first).toEqual({
      attempt: 1,
      detail: "full",
      turn: 0,
      totalTokens: 40000,
      maxTokens: 200000,
      percentage: 20,
      categories: [{ name: "System tools", kind: "used", tokens: 12000 }],
    });
    expect(m.contextUsage?.latest?.totalTokens).toBe(44000);
  });

  it("lists session starts with null resume fields on a fresh start", () => {
    seq = 0;
    const m = runContextMetrics(
      [
        event("log", { source: "sdk", kind: "session_start", sessionSource: "startup" }),
        event(
          "log",
          {
            source: "sdk",
            kind: "session_start",
            sessionSource: "resume",
            contextTokens: 48000,
            promptCacheLikelyExpired: true,
          },
          2,
        ),
      ],
      [],
    );
    expect(m.sessionStarts).toEqual([
      { attempt: 1, source: "startup", contextTokens: null, promptCacheLikelyExpired: null },
      { attempt: 2, source: "resume", contextTokens: 48000, promptCacheLikelyExpired: true },
    ]);
  });

  it("says which system block changed and whether the static prefix moved within an attempt", () => {
    const m = runContextMetrics(
      [],
      [
        shaped(1, { systemStaticSha256: "s1", systemBlockHashes: ["h0", "p"], messagesCount: 3 }),
        shaped(1, { systemStaticSha256: "s1", systemBlockHashes: ["h0", "p"], messagesCount: 5 }),
        shaped(2, {
          systemStaticSha256: "s2",
          systemDynamicSha256: "d",
          systemBlockHashes: ["h1", "p"],
          cacheControlBlocks: 0,
        }),
        request(2, "a"),
      ],
    );
    expect(m.requestShapes).toEqual({
      measured: 3,
      withCacheControl: 2,
      distinctStaticHashes: 2,
      distinctDynamicHashes: 1,
      staticChangedWithinAttempt: false,
      changedSystemBlocks: [0],
      maxSystemChars: 4000,
      maxToolsCount: 44,
      maxToolsChars: 90000,
      maxMessages: 5,
    });
  });
});
