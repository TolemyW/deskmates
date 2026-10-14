// T0 wire golden for the tasks API: every method's exact request and how its answer, a 401
// and an error body surface. `__golden__/api.golden.txt` is the contract; regenerate it with
// `vitest -u` only for an intended wire change. Harness: `src/platform/http-golden.ts`.

import type { CreateTaskInput } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import {
  type GoldenCases,
  WS,
  exerciseCase,
  recordingFetch,
  wireGolden,
} from "../../platform/http-golden.js";
import { createHttpTransport } from "../../platform/http-transport.js";
import { type TasksApi, createTasksApi } from "./api.js";

const CASES: GoldenCases<TasksApi> = {
  acceptTask: (a) => a.acceptTask(WS, "task/1", 4),
  // Absent optional fields must not serialise; `as` lets the case pass an explicit undefined.
  createTask: (a) =>
    a.createTask(WS, { title: "Write", description: undefined } as unknown as CreateTaskInput),
  deleteTask: (a) => a.deleteTask(WS, "task/1", 5),
  getTask: (a) => a.getTask(WS, "task/1"),
  getTaskDetail: (a) => a.getTaskDetail(WS, "task/1"),
  listTasks: (a) => a.listTasks(WS, { status: "blocked", q: "report", offset: 25, limit: 25 }),
  runTask: (a) => a.runTask(WS, "task/1", 2, "run-key-0001"),
  updateTask: (a) => a.updateTask(WS, "task/1", { version: 3, status: "delivered" }),
};

describe("tasks API wire golden", () => {
  it("pins every method's request and answer, and its failure surfaces", async () => {
    await expect(await wireGolden(createTasksApi, CASES)).toMatchFileSnapshot(
      "./__golden__/api.golden.txt",
    );
  });

  it("turns an unreadable error body into an unknown ApiError naming method and path", async () => {
    const html = await exerciseCase(createTasksApi, CASES.listTasks, "html");
    expect(html.outcome).toEqual({
      rejected: {
        error: "ApiError",
        code: "unknown",
        message:
          "GET /api/workspaces/ws%2F1/tasks?status=blocked&q=report&offset=25&limit=25 failed with 502",
        status: 502,
        details: {},
      },
    });
    expect(html.unauthorized).toBe(0);
  });

  it("sends neither tenant nor CSRF when the transport has none", async () => {
    const { fetch, calls } = recordingFetch("ok");
    const api = createTasksApi(createHttpTransport({ fetch }));
    await api.createTask(WS, { title: "t" });
    await api.listTasks(WS);
    expect(calls.map((c) => [c.url, c.headers])).toEqual([
      [
        "/api/workspaces/ws%2F1/tasks",
        { accept: "application/json", "content-type": "application/json" },
      ],
      ["/api/workspaces/ws%2F1/tasks", { accept: "application/json" }],
    ]);
  });
});
