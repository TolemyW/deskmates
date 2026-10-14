import { afterEach, describe, expect, it, vi } from "vitest";
import { ReadDeadlineError, retryTransientRead, transientFetchError } from "./retry-read.js";
import { getRun, waitForRun } from "./runs.js";
import type { Stack } from "./start-stack.js";

function fetchFailure(code = "ECONNRESET"): TypeError {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("socket closed"), { code }),
  });
}

describe("retryTransientRead", () => {
  it("records a temporary network failure and returns the recovered read", async () => {
    let calls = 0;
    let now = 0;
    const observed: unknown[] = [];
    const value = await retryTransientRead(
      async () => {
        calls += 1;
        if (calls === 1) throw fetchFailure();
        return "recovered";
      },
      {
        deadlineAt: 5000,
        retryDelayMs: 1000,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        onTransientError: (error) => observed.push(error),
      },
    );

    expect(value).toBe("recovered");
    expect(calls).toBe(2);
    expect(observed).toEqual([{ message: "fetch failed", code: "ECONNRESET" }]);
  });

  it("keeps the original absolute deadline across persistent failures", async () => {
    let calls = 0;
    let now = 0;
    const errors: unknown[] = [];
    await expect(
      retryTransientRead(
        async () => {
          calls += 1;
          throw fetchFailure("ETIMEDOUT");
        },
        {
          deadlineAt: 2500,
          retryDelayMs: 1000,
          now: () => now,
          sleep: async (ms) => {
            now += ms;
          },
          onTransientError: (error) => errors.push(error),
        },
      ),
    ).rejects.toBeInstanceOf(ReadDeadlineError);
    expect(now).toBe(2500);
    expect(calls).toBe(3);
    expect(errors).toHaveLength(3);
  });

  it("does not classify an ordinary TypeError as a fetch transport failure", () => {
    expect(
      transientFetchError(new TypeError("cannot read properties of undefined")),
    ).toBeUndefined();
  });

  it("records a fixed message instead of a transport cause's free text", () => {
    const error = new TypeError("request contained private details", {
      cause: Object.assign(new Error("upstream detail"), { code: "ECONNRESET" }),
    });
    expect(transientFetchError(error)).toEqual({
      message: "fetch failed",
      code: "ECONNRESET",
    });
  });

  it("aborts a hung read at the same absolute deadline", async () => {
    const started = Date.now();
    const observed: unknown[] = [];
    await expect(
      retryTransientRead(
        (signal) =>
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
        {
          deadlineAt: started + 30,
          retryDelayMs: 1,
          attemptTimeoutMs: 5,
          onTransientError: (error) => observed.push(error),
        },
      ),
    ).rejects.toBeInstanceOf(ReadDeadlineError);
    expect(Date.now() - started).toBeLessThan(200);
    expect(observed).toContainEqual({ message: "fetch timed out", code: "READ_TIMEOUT" });
  });
});

describe("getRun", () => {
  it("does not hide or retry an HTTP error response", async () => {
    let calls = 0;
    const stack = {
      api: async () => {
        calls += 1;
        return { status: 404, json: { code: "not_found" } };
      },
    } as unknown as Stack;

    await expect(getRun(stack, "run-missing")).rejects.toThrow('get run: 404 {"code":"not_found"}');
    expect(calls).toBe(1);
  });
});

describe("waitForRun", () => {
  afterEach(() => vi.useRealTimers());

  it("surfaces an HTTP status error immediately", async () => {
    let calls = 0;
    const stack = {
      api: async () => {
        calls += 1;
        return { status: 404, json: { code: "not_found" } };
      },
    } as unknown as Stack;

    await expect(waitForRun(stack, "run-missing", 5000)).rejects.toThrow(
      'get run: 404 {"code":"not_found"}',
    );
    expect(calls).toBe(1);
  });

  it("recovers a transient status transport failure without starting another run", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const observed: unknown[] = [];
    const stack = {
      api: async () => {
        calls += 1;
        if (calls === 1) throw fetchFailure("ECONNRESET");
        return {
          status: 200,
          json: { run: { id: "run-1", status: "succeeded", attempt: 1 }, usage: [] },
        };
      },
    } as unknown as Stack;

    const waiting = waitForRun(stack, "run-1", 5000, {
      onTransientReadError: (error) => observed.push(error),
    });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(waiting).resolves.toMatchObject({ id: "run-1", status: "succeeded" });
    expect(calls).toBe(2);
    expect(observed).toEqual([{ message: "fetch failed", code: "ECONNRESET" }]);
  });

  it("reports persistent transport failures at the fixed wait deadline", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const stack = {
      api: async () => {
        calls += 1;
        throw fetchFailure("ETIMEDOUT");
      },
    } as unknown as Stack;

    const waiting = expect(waitForRun(stack, "run-1", 2500)).rejects.toThrow(
      /still unknown after 2500 ms; transient read failures:.*ETIMEDOUT/,
    );
    await vi.advanceTimersByTimeAsync(2500);
    await waiting;
    expect(calls).toBe(3);
  });
});
