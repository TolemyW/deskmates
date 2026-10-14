// T0: the SSE subscription opens the documented URL, dispatches the three frame types as typed
// events, ignores frames it cannot parse, and reopens the stream with backoff when the browser
// gives up. `EventSource` is a fake; nothing connects anywhere.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeEventSource, THREAD_ID, message, run, runEvent } from "../test-support/fixtures.js";
import { eventsUrl, parseGatewayEvent, subscribeEvents } from "./events.js";
import type { GatewayEvent } from "./types.js";

describe("eventsUrl", () => {
  it("adds the threadId filter only when given", () => {
    expect(eventsUrl(undefined)).toBe("/api/events");
    expect(eventsUrl("thr_1")).toBe("/api/events?threadId=thr_1");
    expect(eventsUrl("a b", "http://gw")).toBe("http://gw/api/events?threadId=a+b");
  });
});

describe("parseGatewayEvent", () => {
  it("accepts the three documented frame types and nothing else", () => {
    const ok = parseGatewayEvent(JSON.stringify({ type: "run_status", run: run() }));
    expect(ok?.type).toBe("run_status");
    expect(parseGatewayEvent("not json")).toBeUndefined();
    expect(parseGatewayEvent(JSON.stringify({ type: "something_else" }))).toBeUndefined();
    expect(parseGatewayEvent(JSON.stringify(null))).toBeUndefined();
  });
});

describe("subscribeEvents", () => {
  beforeEach(() => {
    FakeEventSource.reset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispatches run_status, run_event and thread_message frames in order", () => {
    const seen: GatewayEvent[] = [];
    const statuses: string[] = [];
    const stop = subscribeEvents({
      threadId: THREAD_ID,
      onEvent: (e) => seen.push(e),
      onStatus: (s) => statuses.push(s),
      EventSource: FakeEventSource as unknown as typeof EventSource,
    });
    const es = FakeEventSource.last;
    expect(es.url).toBe("/api/events?threadId=thr_1");
    es.open();
    es.emit({ type: "run_status", threadId: THREAD_ID, run: run({ status: "running" }) });
    es.emit({ type: "run_event", threadId: THREAD_ID, event: runEvent(1, "log", { a: 1 }) });
    es.emit({ type: "thread_message", threadId: THREAD_ID, message: message(2, "bot", "hi") });
    expect(seen.map((e) => e.type)).toEqual(["run_status", "run_event", "thread_message"]);
    expect(statuses).toEqual(["connecting", "open"]);
    stop();
    expect(es.closed).toBe(true);
  });

  it("never puts a credential on the EventSource URL; the browser sends the session cookie", () => {
    const stop = subscribeEvents({
      onEvent: () => {},
      EventSource: FakeEventSource as unknown as typeof EventSource,
    });
    expect(FakeEventSource.last.url).toBe("/api/events");
    stop();
  });

  it("reopens the stream with doubling backoff after the browser gives up", () => {
    const statuses: string[] = [];
    const stop = subscribeEvents({
      onEvent: () => {},
      onStatus: (s) => statuses.push(s),
      EventSource: FakeEventSource as unknown as typeof EventSource,
      backoffMs: 100,
      maxBackoffMs: 250,
    });
    const first = FakeEventSource.last;
    first.fail();
    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(100);
    expect(FakeEventSource.instances).toHaveLength(2);

    FakeEventSource.last.fail();
    vi.advanceTimersByTime(199);
    expect(FakeEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(3);

    // A successful open resets the backoff to the first delay.
    FakeEventSource.last.open();
    FakeEventSource.last.fail();
    vi.advanceTimersByTime(100);
    expect(FakeEventSource.instances).toHaveLength(4);
    expect(statuses).toContain("reconnecting");
    expect(FakeEventSource.last.url).toBe("/api/events");

    // Stopping cancels a pending reconnect.
    FakeEventSource.last.fail();
    stop();
    vi.advanceTimersByTime(10_000);
    expect(FakeEventSource.instances).toHaveLength(4);
  });

  it("signals onReconnect on every reconnecting → open transition but not on the first open", () => {
    const reconnects: number[] = [];
    const stop = subscribeEvents({
      threadId: THREAD_ID,
      onEvent: () => {},
      onReconnect: () => reconnects.push(FakeEventSource.instances.length),
      EventSource: FakeEventSource as unknown as typeof EventSource,
      backoffMs: 100,
    });

    // The first open is not a recovery: nothing was missed.
    FakeEventSource.last.open();
    expect(reconnects).toEqual([]);

    // A drop the browser retries by itself: the same instance reopens, having missed the frames
    // the Gateway fanned out meanwhile, so the caller must be told to refetch.
    FakeEventSource.last.drop();
    FakeEventSource.last.open();
    expect(reconnects).toEqual([1]);

    // A drop we reopen ourselves after the browser gave up counts the same.
    FakeEventSource.last.fail();
    vi.advanceTimersByTime(100);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(reconnects).toEqual([1]);
    FakeEventSource.last.open();
    expect(reconnects).toEqual([1, 2]);

    // After unsubscribing, a late open signals nothing.
    stop();
    FakeEventSource.last.drop();
    FakeEventSource.last.open();
    expect(reconnects).toEqual([1, 2]);
  });

  it("shares identical subscriptions and reports current status to a late subscriber", () => {
    const firstEvents: GatewayEvent[] = [];
    const secondEvents: GatewayEvent[] = [];
    const firstStatuses: string[] = [];
    const secondStatuses: string[] = [];
    const firstReconnects: string[] = [];
    const secondReconnects: string[] = [];
    const common = {
      EventSource: FakeEventSource as unknown as typeof EventSource,
    };
    const stopFirst = subscribeEvents({
      ...common,
      onEvent: (event) => firstEvents.push(event),
      onStatus: (status) => firstStatuses.push(status),
      onReconnect: () => firstReconnects.push("first"),
    });
    const es = FakeEventSource.last;
    es.open();
    const stopSecond = subscribeEvents({
      ...common,
      onEvent: (event) => secondEvents.push(event),
      onStatus: (status) => secondStatuses.push(status),
      onReconnect: () => secondReconnects.push("second"),
    });
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(firstStatuses).toEqual(["connecting", "open"]);
    expect(secondStatuses).toEqual(["open"]);
    es.emit({ type: "thread_message", threadId: THREAD_ID, message: message(2, "human", "hi") });
    expect(firstEvents).toHaveLength(1);
    expect(secondEvents).toHaveLength(1);
    stopFirst();
    stopFirst();
    expect(es.closed).toBe(false);
    es.drop();
    es.open();
    expect(firstReconnects).toEqual([]);
    expect(secondReconnects).toEqual(["second"]);
    expect(secondStatuses).toEqual(["open", "reconnecting", "open"]);
    stopSecond();
    expect(es.closed).toBe(true);
  });

  it("isolates callbacks and does not merge distinct URL, constructor or retry options", () => {
    const fakeCtor = FakeEventSource as unknown as typeof EventSource;
    const throwing = subscribeEvents({
      EventSource: fakeCtor,
      onEvent: () => {
        throw new Error("listener");
      },
      onStatus: () => {
        throw new Error("status");
      },
      onReconnect: () => {
        throw new Error("reconnect");
      },
    });
    const seen: GatewayEvent[] = [];
    const sibling = subscribeEvents({
      EventSource: fakeCtor,
      onEvent: (event) => seen.push(event),
    });
    expect(FakeEventSource.instances).toHaveLength(1);
    FakeEventSource.last.open();
    FakeEventSource.last.emit({ type: "run_status", threadId: THREAD_ID, run: run() });
    FakeEventSource.last.drop();
    FakeEventSource.last.open();
    expect(seen).toHaveLength(1);

    const separate = [
      subscribeEvents({ EventSource: fakeCtor, threadId: THREAD_ID, onEvent: () => {} }),
      subscribeEvents({ EventSource: fakeCtor, baseUrl: "http://other", onEvent: () => {} }),
      subscribeEvents({ EventSource: fakeCtor, backoffMs: 10, onEvent: () => {} }),
      subscribeEvents({
        EventSource: class extends FakeEventSource {} as unknown as typeof EventSource,
        onEvent: () => {},
      }),
    ];
    expect(FakeEventSource.instances).toHaveLength(5);
    for (const stop of separate) stop();
    sibling();
    throwing();
  });

  it("cancels the physical reconnect only after the final subscriber leaves", () => {
    const opts = {
      EventSource: FakeEventSource as unknown as typeof EventSource,
      onEvent: () => {},
    };
    const first = subscribeEvents(opts);
    const second = subscribeEvents(opts);
    FakeEventSource.last.fail();
    first();
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(2);
    FakeEventSource.last.fail();
    second();
    vi.advanceTimersByTime(10_000);
    expect(FakeEventSource.instances).toHaveLength(2);
    const next = subscribeEvents(opts);
    expect(FakeEventSource.instances).toHaveLength(3);
    next();
  });
});
