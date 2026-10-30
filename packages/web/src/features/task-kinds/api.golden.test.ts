// T0 wire golden for the task-kinds API (ADR-0021 amendment 4): every method's exact request and
// how its answer, a 401 and an error body surface. Regenerate with `vitest -u` only for an
// intended wire change. Harness: `src/platform/http-golden.ts`.

import { describe, expect, it } from "vitest";
import { type GoldenCases, WS, wireGolden } from "../../platform/http-golden.js";
import { type TaskKindsApi, createTaskKindsApi } from "./api.js";

const CASES: GoldenCases<TaskKindsApi> = {
  archiveTaskTemplate: (a) => a.archiveTaskTemplate(WS, "ttpl/1", 2),
  createTaskTemplate: (a) =>
    a.createTaskTemplate(WS, {
      kind: "invoice-check",
      name: "Invoice check",
      stages: [{ key: "check", name: "Check", criteria: ["Totals match"] }],
    }),
  listRelatedTasks: (a) => a.listRelatedTasks(WS, "task/1"),
  listTaskTemplates: (a) => a.listTaskTemplates(WS, true),
  updateTaskTemplate: (a) => a.updateTaskTemplate(WS, "ttpl/1", { version: 1, slaMinutes: 60 }),
};

describe("task-kinds API wire golden", () => {
  it("pins every method's request and answer, and its failure surfaces", async () => {
    await expect(await wireGolden(createTaskKindsApi, CASES)).toMatchFileSnapshot(
      "./__golden__/api.golden.txt",
    );
  });
});
