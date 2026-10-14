import { expect, it } from "vitest";
import { run } from "../test-support/fixtures.js";
import { newerRun } from "./newer-run.js";

it("does not rewind a continuation when an older parked snapshot arrives", () => {
  const resumed = run({ attempt: 2, status: "running" });
  expect(newerRun(resumed, run({ attempt: 1, status: "waiting_continuation" }))).toBe(resumed);
  expect(newerRun(run({ attempt: 1, status: "waiting_continuation" }), resumed)).toBe(resumed);
});

it("preserves a terminal decision against an earlier same-attempt response", () => {
  const stopped = run({ attempt: 2, status: "stopped" });
  expect(newerRun(stopped, run({ attempt: 2, status: "waiting_continuation" }))).toBe(stopped);
});
