import type { PhaseTimingSample } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { PhaseTimer, TimingBuffer } from "./timing.js";

describe("PhaseTimer", () => {
  it("uses a monotonic duration and preserves parent, tool and error outcome", () => {
    const samples: PhaseTimingSample[] = [];
    const monotonic = [20, 27];
    const timer = new PhaseTimer({
      emit: (sample) => samples.push(sample),
      now: () => new Date("2026-09-23T10:00:00.000Z"),
      monotonicNow: () => monotonic.shift() ?? 27,
      id: () => "span-1",
    });
    timer.start("browser_rpc", { parentSpanId: "parent", toolName: "browser_click" }).end("error");
    expect(samples).toEqual([
      expect.objectContaining({ edge: "start", spanId: "span-1", parentSpanId: "parent" }),
      expect.objectContaining({
        edge: "end",
        spanId: "span-1",
        durationMs: 7,
        outcome: "error",
        toolName: "browser_click",
      }),
    ]);
  });

  it("retains an unmatched start sample for an incomplete span", () => {
    const samples: PhaseTimingSample[] = [];
    new PhaseTimer({ emit: (sample) => samples.push(sample), id: () => "unfinished" }).start(
      "browser_rpc",
    );
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ edge: "start", spanId: "unfinished" });
  });

  it("swallows observer and clock exceptions at both span edges", () => {
    const timer = new PhaseTimer({
      emit: () => {
        throw new Error("observer failed");
      },
      id: () => "safe",
    });
    expect(() => timer.start("browser_rpc").end()).not.toThrow();

    const brokenClock = new PhaseTimer({
      emit: () => {},
      monotonicNow: () => {
        throw new Error("clock failed");
      },
    });
    expect(() => brokenClock.start("browser_rpc").end()).not.toThrow();
  });
});

describe("TimingBuffer", () => {
  const sample = (spanId: string): PhaseTimingSample => ({
    source: "phase_timing",
    version: 1,
    spanId,
    phase: "proxy_queue",
    edge: "start",
    at: "2026-09-23T10:00:00.000Z",
  });

  it("batches asynchronously and bounds shutdown flush", async () => {
    const delivered: string[][] = [];
    const buffer = new TimingBuffer({
      batchSize: 2,
      deliver: async (batch) => {
        delivered.push(batch.map((item) => item.spanId));
      },
    });
    buffer.emit(sample("a"));
    buffer.emit(sample("b"));
    buffer.emit(sample("c"));
    expect(delivered).toEqual([]);
    await buffer.flush(100);
    expect(delivered).toEqual([["a", "b"], ["c"]]);
  });

  it("swallows observer failure and keeps browser callers synchronous", async () => {
    const logs: string[] = [];
    const buffer = new TimingBuffer({
      deliver: async () => {
        throw new Error("offline");
      },
      log: (message) => logs.push(message),
    });
    expect(() => buffer.emit(sample("a"))).not.toThrow();
    await buffer.flush(100);
    expect(logs).toEqual(["mcp-proxy: phase timing delivery failed"]);
  });

  it("swallows synchronous delivery and logging failures", async () => {
    const buffer = new TimingBuffer({
      deliver: (() => {
        throw new Error("synchronous failure");
      }) as () => Promise<void>,
      log: () => {
        throw new Error("logging failure");
      },
    });
    buffer.emit(sample("a"));
    await expect(buffer.flush(100)).resolves.toBeUndefined();
  });

  it("drops excess samples rather than growing without bound", async () => {
    let release: (() => void) | undefined;
    const delivered: string[][] = [];
    const buffer = new TimingBuffer({
      maxSamples: 2,
      batchSize: 1,
      deliver: async (batch) => {
        delivered.push(batch.map((item) => item.spanId));
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    buffer.emit(sample("a"));
    buffer.emit(sample("b"));
    buffer.emit(sample("c"));
    await Promise.resolve();
    release?.();
    await Promise.resolve();
    await Promise.resolve();
    release?.();
    await buffer.flush(1);
    expect(delivered.flat()).toEqual(["a", "b"]);
  });
});
