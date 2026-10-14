import { describe, expect, it } from "vitest";
import { TASK_LIMITS, acceptTaskVersion, createTaskInput, updateTaskInput } from "./validate.js";

describe("strict bounded task inputs", () => {
  it.each([
    null,
    [],
    "task",
    {},
    { title: " " },
    { title: 3 },
    { title: "a".repeat(TASK_LIMITS.title + 1) },
    { title: "Task", description: "a".repeat(TASK_LIMITS.description + 1) },
    { title: "Task", ownerBotId: false },
    { title: "Task", ownerBotId: "a".repeat(TASK_LIMITS.id + 1) },
    { title: "Task", description: null },
    { title: "Task", status: "planned" },
    { title: "Task", version: 1 },
    { title: "Task", acceptedBy: "human:spoof" },
    { title: "Task", threadIds: null },
    { title: "Task", runIds: [5] },
    { title: "Task", threadIds: ["same", "same"] },
    { title: "Task", runIds: Array.from({ length: 101 }, (_, i) => `run_${i}`) },
    { title: "Task", artifacts: null },
    { title: "Task", artifacts: [null] },
    { title: "Task", artifacts: [{ label: "", path: "/work/a" }] },
    { title: "Task", artifacts: [{ label: "File", path: "/work/a", runId: null }] },
    { title: "Task", artifacts: [{ label: "File", path: "/work/a", sha256: "fake" }] },
    {
      title: "Task",
      artifacts: Array.from({ length: 51 }, () => ({ label: "File", path: "/work/a" })),
    },
    { title: "Task", artifacts: [{ label: "a".repeat(201), path: "/work/a" }] },
    { title: "Task", artifacts: [{ label: "File", path: "a".repeat(4097) }] },
  ])("rejects invalid create payload %j", (input) =>
    expect(() => createTaskInput(input)).toThrowError(),
  );

  it.each([
    undefined,
    null,
    0,
    -1,
    1.5,
    "1",
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER,
  ])("rejects invalid version %j", (version) => {
    expect(() => updateTaskInput({ version, title: "Task" })).toThrowError();
    expect(() => acceptTaskVersion({ version })).toThrowError();
  });

  it.each([
    { version: 1, status: "accepted" },
    { version: 1, status: "running" },
    { version: 1, status: null },
    { version: 1, blockedReason: null },
    { version: 1, nextAction: "a".repeat(2001) },
    { version: 1, blockedReason: "a".repeat(2001) },
    { version: 1, workspaceId: "foreign" },
    { version: 1, acceptedAt: "now" },
  ])("rejects invalid update payload %j", (input) =>
    expect(() => updateTaskInput(input)).toThrowError(),
  );

  it("rejects acceptance spoofing or extra status fields", () => {
    for (const body of [
      { version: 1, acceptedBy: "human:alice" },
      { version: 1, authorId: "alice" },
      { version: 1, status: "accepted" },
      { version: 1, acceptedAt: "now" },
    ])
      expect(() => acceptTaskVersion(body)).toThrowError();
    expect(acceptTaskVersion({ version: 1 })).toBe(1);
  });

  it("accepts exact bounds, empty optional strings/lists and nullable ownership", () => {
    const input = {
      title: "a".repeat(200),
      description: "a".repeat(20_000),
      ownerBotId: null,
      threadIds: Array.from({ length: 100 }, (_, i) => `thread_${i}`),
      runIds: [],
      artifacts: Array.from({ length: 50 }, () => ({
        label: "a".repeat(200),
        path: "a".repeat(4096),
      })),
    };
    expect(createTaskInput(input)).toEqual(input);
    expect(
      updateTaskInput({
        version: 1,
        description: "",
        blockedReason: "",
        nextAction: "",
        threadIds: [],
        runIds: [],
        artifacts: [],
        ownerBotId: null,
      }),
    ).toMatchObject({ description: "", ownerBotId: null, artifacts: [] });
  });
});
