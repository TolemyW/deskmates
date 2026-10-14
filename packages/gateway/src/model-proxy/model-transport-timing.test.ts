import type { PhaseTimingSample } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { ModelTransportTiming } from "./model-transport-timing.js";

function scriptedTiming(record: (sample: PhaseTimingSample) => unknown = () => undefined) {
  let elapsed = 0;
  let id = 0;
  return {
    timing: new ModelTransportTiming({
      record,
      monotonicNow: () => elapsed,
      wallNow: () => new Date(1_800_000_000_000 + elapsed),
      spanId: () => `span-${++id}`,
    }),
    advance(ms: number) {
      elapsed += ms;
    },
  };
}

function ends(samples: PhaseTimingSample[]) {
  return Object.fromEntries(
    samples.filter((s) => s.edge === "end").map((s) => [s.phase, s]),
  ) as Record<string, PhaseTimingSample>;
}

describe("model transport timing", () => {
  it("measures delayed headers, first byte and body as overlapping spans", () => {
    const samples: PhaseTimingSample[] = [];
    const clock = scriptedTiming((s) => samples.push(s));
    clock.advance(30);
    clock.timing.receivedHeaders();
    clock.advance(20);
    clock.timing.receivedBytes(4);
    clock.advance(40);
    clock.timing.completed();

    const end = ends(samples);
    expect(end.model_headers).toMatchObject({ durationMs: 30, outcome: "ok" });
    expect(end.model_first_byte).toMatchObject({ durationMs: 50, outcome: "ok" });
    expect(end.model_body).toMatchObject({ durationMs: 60, outcome: "ok" });
    expect(end.model_request).toMatchObject({ durationMs: 90, outcome: "ok" });
    expect(samples.filter((s) => s.edge === "end")).toHaveLength(4);
    expect(samples.every((sample) => sample.requestKind === undefined)).toBe(true);
    expect(end.model_headers?.parentSpanId).toBe("span-1");
    expect(end.model_body?.parentSpanId).toBe("span-1");
  });

  it("labels both edges with the fixed endpoint kind", () => {
    const samples: PhaseTimingSample[] = [];
    const timing = new ModelTransportTiming({
      record: (sample) => samples.push(sample),
      requestKind: "count_tokens",
    });
    timing.receivedHeaders();
    timing.receivedBytes(1);
    timing.completed();
    expect(samples).toHaveLength(8);
    expect(samples.every((sample) => sample.requestKind === "count_tokens")).toBe(true);
  });

  it("marks first byte absent for a valid empty body without inventing zero latency", () => {
    const samples: PhaseTimingSample[] = [];
    const clock = scriptedTiming((s) => samples.push(s));
    clock.advance(7);
    clock.timing.receivedHeaders();
    clock.advance(3);
    clock.timing.completed();

    const end = ends(samples);
    expect(end.model_first_byte).toMatchObject({ durationMs: 10, outcome: "cancelled" });
    expect(end.model_body).toMatchObject({ durationMs: 3, outcome: "ok" });
    expect(end.model_request).toMatchObject({ durationMs: 10, outcome: "ok" });
  });

  it("terminates every applicable span exactly once on error or cancellation", () => {
    for (const terminal of ["failed", "cancelled"] as const) {
      const samples: PhaseTimingSample[] = [];
      const clock = scriptedTiming((s) => samples.push(s));
      clock.advance(2);
      clock.timing.receivedHeaders();
      clock.advance(4);
      clock.timing[terminal]();
      clock.timing[terminal]();
      clock.timing.completed();

      const expected = terminal === "failed" ? "error" : "cancelled";
      expect(samples.filter((s) => s.edge === "end")).toHaveLength(4);
      expect(Object.values(ends(samples)).map((s) => s.outcome)).toEqual([
        "ok",
        expected,
        expected,
        expected,
      ]);
    }
  });

  it("isolates synchronous and asynchronous observer failures", async () => {
    let calls = 0;
    const clock = scriptedTiming(() => {
      calls += 1;
      if (calls % 2 === 0) return Promise.reject(new Error("ledger offline"));
      throw new Error("ledger offline");
    });
    expect(() => {
      clock.timing.receivedHeaders();
      clock.timing.receivedBytes(1);
      clock.timing.completed();
    }).not.toThrow();
    await Promise.resolve();
    expect(calls).toBe(8);
  });
});
