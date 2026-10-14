import type { ExecRequest, SandboxHandle, Workspace } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { createGroupBot, createGroupThread } from "./m2-group.js";
import type { Stack } from "./start-stack.js";

interface ApiCall {
  method: string;
  path: string;
  body: unknown;
}

function fakeStack() {
  const calls: ApiCall[] = [];
  const execs: { handle: SandboxHandle; req: ExecRequest }[] = [];
  const workspace = { id: "ws_own" } as Workspace;
  const handle = { providerRef: "own-container" } as SandboxHandle;
  const stack = {
    workspace,
    handle,
    api: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      if (path === "/api/bots") {
        const spec = body as { name: string };
        return { status: 201, json: { bot: { id: `bot_${spec.name}`, name: spec.name } } };
      }
      if (path.endsWith("/soul")) {
        return { status: 200, json: { soul: { version: "0".repeat(64) } } };
      }
      return { status: 201, json: { thread: { id: "thr_1" } } };
    },
    provider: {
      exec: async (target: SandboxHandle, req: ExecRequest) => {
        execs.push({ handle: target, req });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Stack;
  return { stack, calls, execs, workspace, handle };
}

describe("createGroupBot", () => {
  it("targets the stack's own workspace and omits model fields when unset", async () => {
    const { stack, calls, execs, handle } = fakeStack();
    await createGroupBot(stack, { name: "chief", role: "chief", soul: "# chief" });
    expect(calls[0]?.body).toEqual({ name: "chief", role: "chief", workspaceId: "ws_own" });
    expect(execs).toHaveLength(1);
    expect(execs[0]?.handle).toBe(handle);
    expect(execs[0]?.req.stdin).toBe("# chief");
    // The SOUL is installed through the canonical route, against the version just read.
    expect(calls.slice(1)).toEqual([
      { method: "GET", path: "/api/bots/bot_chief/soul", body: undefined },
      {
        method: "PATCH",
        path: "/api/bots/bot_chief/soul",
        body: { body: "# chief", expectedVersion: "0".repeat(64) },
      },
    ]);
  });

  it("forwards model, cheapModel and messageAllowlist only when set", async () => {
    const { stack, calls } = fakeStack();
    await createGroupBot(stack, {
      name: "chief",
      role: "chief",
      soul: "# chief",
      model: "model-a",
      cheapModel: "model-a-cheap",
      messageAllowlist: ["analyst"],
    });
    expect(calls[0]?.body).toEqual({
      name: "chief",
      role: "chief",
      workspaceId: "ws_own",
      model: "model-a",
      cheapModel: "model-a-cheap",
      messageAllowlist: ["analyst"],
    });
  });

  it("creates the bot in the target workspace and writes SOUL.md into the target container", async () => {
    const { stack, calls, execs } = fakeStack();
    const target = {
      workspace: { id: "ws_other" } as Workspace,
      handle: { providerRef: "other-container" } as SandboxHandle,
    };
    await createGroupBot(stack, { name: "analyst", role: "analyst", soul: "# analyst" }, target);
    expect(calls[0]?.body).toMatchObject({ workspaceId: "ws_other" });
    expect(execs[0]?.handle).toBe(target.handle);
  });
});

describe("createGroupThread", () => {
  it("defaults to the stack's workspace and honours a target workspace", async () => {
    const { stack, calls } = fakeStack();
    const bots = [{ id: "bot_1" }, { id: "bot_2" }] as never[];
    await createGroupThread(stack, bots, "own");
    await createGroupThread(stack, bots, "other", {
      workspace: { id: "ws_other" } as Workspace,
      handle: { providerRef: "other-container" } as SandboxHandle,
    });
    expect(calls.map((call) => call.body)).toEqual([
      { workspaceId: "ws_own", botIds: ["bot_1", "bot_2"], title: "own" },
      { workspaceId: "ws_other", botIds: ["bot_1", "bot_2"], title: "other" },
    ]);
  });
});
