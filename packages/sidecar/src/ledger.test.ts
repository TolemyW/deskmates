// T0: the ledger sink retries a batch the Gateway did not take, keeps order, and gives up only
// after a bounded backoff (issue #68). A redelivered batch is safe: the Gateway drops an event it
// already holds by `(run, attempt, seq)` (`gateway/src/ledger/events.test.ts`, "drops a
// redelivered sidecar event").

import { DeskmatesError, type RunId, type SidecarEvent } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { BATCH_RETRY_DELAYS_MS, EventSink } from "./ledger.js";

function sinkWith(post: (batch: readonly SidecarEvent[]) => Promise<void>) {
  const slept: number[] = [];
  const errors: unknown[] = [];
  const sink = new EventSink({
    runId: "run-1" as RunId,
    attempt: 1,
    post,
    redact: (payload) => payload,
    now: () => new Date(0),
    batchDelayMs: 60_000,
    sleep: async (ms) => {
      slept.push(ms);
    },
    onError: (err) => errors.push(err),
  });
  return { sink, slept, errors };
}

describe("EventSink batch retry", () => {
  it("backs off over about 15 s in total", () => {
    const total = BATCH_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
    expect(total).toBeGreaterThanOrEqual(10_000);
    expect(total).toBeLessThanOrEqual(20_000);
  });

  it("delivers a batch the Gateway refused twice, once, and keeps later batches behind it", async () => {
    const delivered: number[][] = [];
    let failures = 2;
    const { sink, slept, errors } = sinkWith(async (batch) => {
      if (failures > 0) {
        failures -= 1;
        throw new TypeError("fetch failed");
      }
      delivered.push(batch.map((e) => e.seq ?? 0));
    });
    sink.emit("log", { n: 1 });
    sink.emit("log", { n: 2 });
    const first = sink.flush();
    sink.emit("log", { n: 3 });
    await first;
    await sink.flush();
    expect(delivered).toEqual([[1, 2], [3]]);
    expect(slept).toEqual(BATCH_RETRY_DELAYS_MS.slice(0, 2));
    expect(errors).toEqual([]);
  });

  it("drops the batch and reports once when the Gateway stays away", async () => {
    let calls = 0;
    const { sink, slept, errors } = sinkWith(async () => {
      calls += 1;
      throw new TypeError("fetch failed");
    });
    sink.emit("log", { n: 1 });
    await sink.flush();
    expect(calls).toBe(BATCH_RETRY_DELAYS_MS.length + 1);
    expect(slept).toEqual([...BATCH_RETRY_DELAYS_MS]);
    expect(errors).toHaveLength(1);
  });

  it("after one batch exhausts its backoff, tries later batches once until a post succeeds", async () => {
    let up = false;
    let calls = 0;
    const { sink, slept, errors } = sinkWith(async () => {
      calls += 1;
      if (!up) throw new TypeError("fetch failed");
    });
    sink.emit("log", { n: 1 });
    await sink.flush();
    sink.emit("log", { n: 2 });
    await sink.flush();
    expect(calls).toBe(BATCH_RETRY_DELAYS_MS.length + 2);
    expect(slept).toEqual([...BATCH_RETRY_DELAYS_MS]);
    expect(errors).toHaveLength(2);
    up = true;
    sink.emit("log", { n: 3 });
    await sink.flush();
    up = false;
    sink.emit("log", { n: 4 });
    await sink.flush();
    // The Gateway came back, so the next failure gets the full backoff again.
    expect(slept).toEqual([...BATCH_RETRY_DELAYS_MS, ...BATCH_RETRY_DELAYS_MS]);
  });

  it("does not retry a batch the Gateway rejected on its merits", async () => {
    let calls = 0;
    const { sink, slept, errors } = sinkWith(async () => {
      calls += 1;
      throw new DeskmatesError("validation", "event attempt is not this run's attempt", {
        status: 400,
      });
    });
    sink.emit("log", { n: 1 });
    await sink.flush();
    expect(calls).toBe(1);
    expect(slept).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});

describe("EventSink acknowledgements (ADR-0029 decision 2)", () => {
  it("hands every acknowledgement to onAck, which is how a live run hears of a drain", async () => {
    const acks: unknown[] = [];
    let drain = false;
    const sink = new EventSink({
      runId: "run-1" as RunId,
      attempt: 1,
      post: async (batch) => ({ stored: batch.length, ...(drain ? { drain: true as const } : {}) }),
      onAck: (ack) => acks.push(ack),
      redact: (payload) => payload,
      now: () => new Date(0),
      batchDelayMs: 60_000,
    });
    sink.emit("log", { n: 1 });
    await sink.flush();
    drain = true;
    sink.emit("log", { n: 2 });
    await sink.flush();
    expect(acks).toEqual([{ stored: 1 }, { stored: 1, drain: true }]);
  });

  it("an older Gateway that acknowledges nothing is not a drain", async () => {
    const acks: unknown[] = [];
    const sink = new EventSink({
      runId: "run-1" as RunId,
      attempt: 1,
      post: async () => undefined,
      onAck: (ack) => acks.push(ack),
      redact: (payload) => payload,
      now: () => new Date(0),
      batchDelayMs: 60_000,
    });
    sink.emit("log", { n: 1 });
    await sink.flush();
    expect(acks).toEqual([]);
  });
});
