import type { WorkspaceId } from "@deskmates/contracts";
import { describe, expect, it, vi } from "vitest";
import { WS_ID, fakeFetch, task } from "../test-support/fixtures.js";
import { createApiClient } from "./client.js";
import { ApiError } from "./types.js";

describe("task API client", () => {
  it("scopes and encodes every route, unwraps records, and sends OCC versions", async () => {
    const ws = "ws/a" as WorkspaceId;
    const path = "/api/workspaces/ws%2Fa/tasks";
    const row = task({ id: "task/a", workspaceId: ws });
    const wire = fakeFetch({
      [`GET ${path}`]: { tasks: [row] },
      [`GET ${path}/task%2Fa`]: { task: row },
      [`POST ${path}`]: { task: row },
      [`PATCH ${path}/task%2Fa`]: { task: row },
      [`POST ${path}/task%2Fa/accept`]: { task: row },
    });
    const fetch = vi.fn(wire.fetch);
    const api = createApiClient({ fetch, csrfToken: () => "csrf-1" });
    expect((await api.listTasks(ws)).tasks).toEqual([row]);
    expect(await api.getTask(ws, row.id)).toEqual(row);
    expect(await api.createTask(ws, { title: row.title })).toEqual(row);
    expect(await api.updateTask(ws, row.id, { version: 3, status: "delivered" })).toEqual(row);
    expect(await api.acceptTask(ws, row.id, 4)).toEqual(row);
    expect(wire.calls.map((call) => call.body)).toEqual([
      undefined,
      undefined,
      { title: row.title },
      { version: 3, status: "delivered" },
      { version: 4 },
    ]);
    // The session is the browser's cookie; the client adds only the CSRF token, and only to
    // unsafe methods (ADR-0022 P1).
    for (const [, options] of fetch.mock.calls) {
      const headers = new Headers(options?.headers);
      expect(headers.get("authorization")).toBeNull();
      expect(options?.credentials).toBe("same-origin");
      expect(headers.get("x-deskmates-csrf")).toBe(options?.method === "GET" ? null : "csrf-1");
    }
  });

  it("expires rejected credentials, but retains typed version conflicts", async () => {
    const onUnauthorized = vi.fn();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: "conflict", message: "Task changed" }), {
          status: 409,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: "unauthorized", message: "Expired" }), { status: 401 }),
      );
    const api = createApiClient({ fetch, onUnauthorized });
    await expect(
      api.updateTask(WS_ID, "task_1", { version: 1, title: "Draft" }),
    ).rejects.toMatchObject({
      status: 409,
      code: "conflict",
    });
    expect(onUnauthorized).not.toHaveBeenCalled();
    await expect(api.acceptTask(WS_ID, "task_1", 1)).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
});
