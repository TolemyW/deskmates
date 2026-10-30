import { expect, it } from "vitest";
import { DemoState } from "../../demo/state.js";
import { demo } from "./demo.js";

it("previews archived workspaces and restores one without duplicating it", async () => {
  const state = new DemoState(() => {});
  const ws = state.addWorkspace("Active", ["*"]);
  const bot = state.addBot("assistant", "Assistant", ws.id, "Assistant");
  demo.seed?.run(state, {
    now: Date.parse("2026-10-27T00:00:00Z"),
    ws,
    chief: bot,
    qa: bot,
    researcher: bot,
  });
  const request = (method: string, path: string) =>
    demo.route?.(
      { method, path, query: new URLSearchParams(), body: {}, match: (re) => path.match(re) },
      state,
    );
  const before = await request("GET", "/api/trash");
  expect(before?.json).toMatchObject({
    total: 1,
    workspaces: [{ id: "ws_demo_archived", name: "Completed research" }],
  });
  expect(state.workspaces).toHaveLength(1);
  const restored = await request("POST", "/api/workspaces/ws_demo_archived/restore");
  expect(restored?.status).toBe(200);
  expect(state.workspaces).toHaveLength(2);
  expect(state.workspaces[1]?.archivedAt).toBeUndefined();
  expect((await request("GET", "/api/trash"))?.json).toMatchObject({ total: 0, workspaces: [] });
  await request("POST", "/api/workspaces/ws_demo_archived/restore");
  expect(state.workspaces).toHaveLength(2);
});
