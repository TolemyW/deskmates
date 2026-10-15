import { describe, expect, it } from "vitest";
import { PendingCaptures } from "./pending-captures.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("PendingCaptures (issue #9)", () => {
  it("settles only after every capture, including one added while settling", async () => {
    const captures = new PendingCaptures(() => {});
    const first = deferred();
    const second = deferred();
    captures.add(first.promise);
    let settled = false;
    const done = captures.settle().then(() => {
      settled = true;
    });
    captures.add(second.promise);
    first.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    second.resolve();
    await done;
    expect(settled).toBe(true);
    expect(captures.size).toBe(0);
  });

  it("reports a capture that threw instead of failing the run", async () => {
    const errors: unknown[] = [];
    const captures = new PendingCaptures((err) => errors.push(err));
    const failing = deferred();
    captures.add(failing.promise);
    failing.reject(new Error("read failed"));
    await captures.settle();
    expect(errors).toEqual([new Error("read failed")]);
  });
});
