// T0 wire golden for the runs API: every method's exact request and how its answer, a 401
// and an error body surface. `__golden__/api.golden.txt` is the contract; regenerate it with
// `vitest -u` only for an intended wire change. Harness: `src/platform/http-golden.ts`.

import { describe, expect, it } from "vitest";
import { type GoldenCases, RUN, THR, WS, wireGolden } from "../../platform/http-golden.js";
import { type RunsApi, createRunsApi } from "./api.js";

const CASES: GoldenCases<RunsApi> = {
  cancelRun: (a) => a.cancelRun(RUN),
  decideContinuation: (a) => a.decideContinuation(RUN, "stop"),
  getRun: (a) => a.getRun(RUN),
  getRunContext: (a) => a.getRunContext(RUN),
  getRunTimeline: (a) => a.getRunTimeline(RUN),
  latestRunsByBot: (a) => a.latestRunsByBot(WS),
  listRunEventSlice: (a) => a.listRunEventSlice(RUN, { beforeSeq: 401, limit: 200 }),
  listRunEvents: (a) => a.listRunEvents(RUN, 0),
  listRuns: (a) => a.listRuns({ threadId: THR, phase: "finished", cursor: "c/1", limit: 20 }),
  memoryIndexObservation: (a) => a.memoryIndexObservation(WS),
};

describe("runs API wire golden", () => {
  it("pins every method's request and answer, and its failure surfaces", async () => {
    await expect(await wireGolden(createRunsApi, CASES)).toMatchFileSnapshot(
      "./__golden__/api.golden.txt",
    );
  });
});
