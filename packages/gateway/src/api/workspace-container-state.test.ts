// T1 (in-process), issue #15: `GET /api/workspaces/:id` says whether the workspace container
// exists and, when it does not, whether an earlier run had one; `GET /api/threads/:id` marks a
// chat of an archived workspace, where a message is refused rather than starting a container.

import {
  type Run,
  type WorkspaceContainerState,
  type WorkspaceId,
  isTerminal,
} from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  if (h) await h.close();
});

async function containerOf(id: WorkspaceId): Promise<WorkspaceContainerState> {
  const view = await h.api<{ container: WorkspaceContainerState }>("GET", `/api/workspaces/${id}`);
  expect(view.status).toBe(200);
  return view.json.container;
}

describe("workspace container state (#15)", () => {
  it("reports never created, then present, then removed once the container is gone", async () => {
    const { workspace, thread } = await h.seed();
    expect(await containerOf(workspace.id)).toBe("never_created");
    expect(h.provider.created).toHaveLength(0);

    // The first message creates the container: the run starts it.
    const posted = await h.api("POST", `/api/threads/${thread.id}/messages`, { body: "hi" });
    expect(posted.status).toBe(201);
    await waitFor(async () => {
      const runs = await h.api<{ runs: Run[] }>("GET", `/api/runs?threadId=${thread.id}`);
      return runs.json.runs.length > 0 && runs.json.runs.every((r) => isTerminal(r.status));
    });
    expect(h.provider.created).toHaveLength(1);
    expect(await containerOf(workspace.id)).toBe("present");

    // The container goes (here stopped by the Gateway; on the host, `docker rm` looks the same).
    await h.app.deskmates.ctx.sandboxes.stop(workspace.id);
    expect(await containerOf(workspace.id)).toBe("removed");
    // Reading the state never starts a machine.
    expect(h.provider.created).toHaveLength(1);
  });

  it("marks a chat of an archived workspace, whose messages are refused", async () => {
    const { workspace, thread } = await h.seed();
    const before = await h.api<Record<string, unknown>>("GET", `/api/threads/${thread.id}`);
    expect(before.json.workspaceArchived).toBeUndefined();

    await h.api("POST", `/api/workspaces/${workspace.id}/archive`);
    const after = await h.api<Record<string, unknown>>("GET", `/api/threads/${thread.id}`);
    expect(after.status).toBe(200);
    expect(after.json.workspaceArchived).toBe(true);

    const refused = await h.api<{ code: string }>("POST", `/api/threads/${thread.id}/messages`, {
      body: "anyone there?",
    });
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe("invalid_transition");
    expect(h.provider.created).toHaveLength(0);
    expect((await h.api("GET", `/api/workspaces/${workspace.id}`)).status).toBe(404);
  });
});
