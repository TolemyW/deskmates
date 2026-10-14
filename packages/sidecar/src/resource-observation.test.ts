import { expect, it } from "vitest";
import { readResourceObservation } from "./resource-observation.js";
it("distinguishes workspace memory from sidecar RSS and omits unavailable measurements", async () => {
  const values: Record<string, string> = {
    "/sys/fs/cgroup/memory.current": "12345",
    "/sys/fs/cgroup/memory.peak": "23456",
  };
  expect(
    await readResourceObservation(
      async (p) => {
        if (!(p in values)) throw new Error("missing");
        return values[p] ?? "";
      },
      () => 1000,
    ),
  ).toEqual({
    sidecarRssBytes: 1000,
    workspaceMemoryBytes: 12345,
    workspaceMemoryPeakBytes: 23456,
  });
  expect(
    await readResourceObservation(
      async () => {
        throw new Error("missing");
      },
      () => 1000,
    ),
  ).toEqual({ sidecarRssBytes: 1000 });
});
