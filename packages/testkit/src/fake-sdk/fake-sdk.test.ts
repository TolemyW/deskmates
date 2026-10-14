// The fake must read and write exactly the shapes the S0 spike code relied on. Each block below
// names the spike file whose reads it reproduces, so an SDK upgrade that changes a shape is caught
// here before it reaches the sidecar (test strategy §3.1).

import { describe, expect, it } from "vitest";
import { createFakeSdk } from "./fake-sdk.js";
import type { ScriptStep } from "./script.js";
import type {
  SdkHookCallback,
  SdkHookOutput,
  SdkMessage,
  SdkPreCompactHookInput,
  SdkPreToolUseHookInput,
  SdkQueryOptions,
} from "./sdk-shapes.js";

const allow = (): SdkHookOutput => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
});

async function collect(gen: AsyncIterable<SdkMessage>): Promise<SdkMessage[]> {
  const out: SdkMessage[] = [];
  for await (const m of gen) out.push(m);
  return out;
}

const twoCommands: ScriptStep[] = [
  { type: "thinking", text: "I should run the command." },
  { type: "tool_call", name: "Bash", input: { command: "echo step1 > L0-DONE.txt" }, result: "" },
  { type: "tool_call", name: "Bash", input: { command: "echo sent > L2-DONE.txt" }, result: "" },
  { type: "text", text: "DONE" },
  { type: "end", summary: "DONE", usage: { inputTokens: 100, cacheReadTokens: 18176 } },
];

describe("fake SDK message shapes (spikes/s0/test-a/run-endpoint.mjs, test-b/step1-defer.mjs)", () => {
  it("emits system/init with session_id, assistant blocks, tool results and one result", async () => {
    const sdk = createFakeSdk(twoCommands);
    const hookCmds: string[] = [];
    const hook: SdkHookCallback = async (i: SdkPreToolUseHookInput) => {
      // run-endpoint.mjs: `i.tool_input?.command`
      hookCmds.push((i.tool_input as { command: string }).command);
      return allow();
    };
    const options: SdkQueryOptions = {
      model: "m",
      cwd: "/tmp",
      settingSources: [],
      maxTurns: 6,
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [hook] }] },
    };
    const msgs = await collect(sdk.query({ prompt: "go", options }));

    // step1-defer.mjs: `msg.type === "system" && msg.subtype === "init"` -> sessionId
    const init = msgs[0];
    expect(init?.type).toBe("system");
    if (init?.type !== "system") throw new Error("unreachable");
    expect(init.subtype).toBe("init");
    expect(typeof init.session_id).toBe("string");

    // run-endpoint.mjs: `msg.message?.content?.map(b => b.type)`
    const blockTypes = msgs
      .filter((m) => m.type === "assistant")
      .map((m) => (m.type === "assistant" ? m.message.content.map((b) => b.type) : []));
    expect(blockTypes).toEqual([["thinking"], ["tool_use"], ["tool_use"], ["text"]]);
    expect(hookCmds).toEqual(["echo step1 > L0-DONE.txt", "echo sent > L2-DONE.txt"]);

    // tool results come back as user messages with tool_result blocks
    const users = msgs.filter((m) => m.type === "user");
    expect(users).toHaveLength(2);
    const first = users[0];
    if (first?.type !== "user") throw new Error("unreachable");
    expect(first.message.content[0]?.type).toBe("tool_result");

    // run-endpoint.mjs: result fields subtype/text/turns/cost/usage/modelUsage
    const result = msgs.at(-1);
    if (result?.type !== "result") throw new Error("expected a result message last");
    expect(msgs.filter((m) => m.type === "result")).toHaveLength(1);
    expect(result.subtype).toBe("success");
    if (result.subtype !== "success") throw new Error("unreachable");
    expect(result.result).toBe("DONE");
    expect(result.num_turns).toBe(3);
    expect(result.total_cost_usd).toBe(0);
    expect(result.usage.cache_read_input_tokens).toBe(18176);
    expect(result.modelUsage.m?.cacheReadInputTokens).toBe(18176);
    expect(result.modelUsage.m?.costBasis).toBe("unknown");
    expect(result.session_id).toBe(init.session_id);
  });

  it("gives the hook the PreToolUse input shape and the toolUseID argument", async () => {
    const sdk = createFakeSdk(twoCommands);
    const seen: { input: SdkPreToolUseHookInput; toolUseID: string | undefined }[] = [];
    const hook: SdkHookCallback = async (input, toolUseID) => {
      seen.push({ input, toolUseID });
      return allow();
    };
    await collect(
      sdk.query({ prompt: "go", options: { hooks: { PreToolUse: [{ hooks: [hook] }] } } }),
    );
    const s = seen[0];
    if (!s) throw new Error("hook not called");
    expect(s.input.hook_event_name).toBe("PreToolUse");
    expect(s.input.tool_name).toBe("Bash");
    expect(s.input.tool_use_id).toBe(s.toolUseID);
    expect(typeof s.input.session_id).toBe("string");
    expect(typeof s.input.cwd).toBe("string");
    expect(typeof s.input.transcript_path).toBe("string");
  });

  it("applies the matcher as a tool-name regex", async () => {
    const sdk = createFakeSdk([
      { type: "tool_call", name: "Bash", input: { command: "x" }, result: "" },
      { type: "tool_call", name: "Read", input: { file_path: "/a" }, result: "" },
      { type: "end", summary: "" },
    ]);
    const names: string[] = [];
    const hook: SdkHookCallback = async (i) => {
      names.push(i.tool_name);
      return allow();
    };
    await collect(
      sdk.query({
        prompt: "go",
        options: { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [hook] }] } },
      }),
    );
    expect(names).toEqual(["Bash"]);
  });
});

describe("hook decisions (spikes/s0/test-b/step1-defer.mjs, step2-resume.mjs)", () => {
  it("deny: permissionDecisionReason becomes an error tool_result and the script continues", async () => {
    const sdk = createFakeSdk(twoCommands);
    const hook: SdkHookCallback = async (i) => {
      const cmd = (i.tool_input as { command: string }).command;
      if (cmd.includes("L2-DONE")) {
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: "Denied by human",
          },
        };
      }
      return allow();
    };
    const msgs = await collect(
      sdk.query({ prompt: "go", options: { hooks: { PreToolUse: [{ hooks: [hook] }] } } }),
    );
    const results = msgs.filter((m) => m.type === "user");
    const denied = results[1];
    if (denied?.type !== "user") throw new Error("unreachable");
    expect(denied.message.content[0]).toMatchObject({
      type: "tool_result",
      content: "Denied by human",
      is_error: true,
    });
    expect(msgs.at(-1)?.type).toBe("result");
    const session = [...sdk.sessions.values()][0];
    expect(session?.toolCalls.map((c) => c.hookDecision)).toEqual(["allow", "deny"]);
    expect(session?.toolCalls[1]?.executed).toBe(false);
  });

  it("defer: the query ends at once with a success result that carries the session id", async () => {
    const sdk = createFakeSdk(twoCommands);
    const hook: SdkHookCallback = async (i) => {
      const cmd = (i.tool_input as { command: string }).command;
      if (cmd.includes("L2-DONE")) {
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "defer",
            permissionDecisionReason: "L2 action: waiting for human approval",
          },
        };
      }
      return allow();
    };
    const msgs = await collect(
      sdk.query({ prompt: "go", options: { hooks: { PreToolUse: [{ hooks: [hook] }] } } }),
    );
    const result = msgs.at(-1);
    if (result?.type !== "result" || result.subtype !== "success")
      throw new Error("expected success result");
    // step1-defer.mjs: resultSubtype "success", L2 marker not written, sessionId from the result
    expect(result.deferred_tool_use?.name).toBe("Bash");
    const session = sdk.sessions.get(result.session_id);
    expect(session?.deferred?.name).toBe("Bash");
    expect(session?.toolCalls).toHaveLength(2);
    expect(session?.toolCalls[1]?.executed).toBe(false);
    // no assistant text after the deferred call was emitted
    expect(msgs.filter((m) => m.type === "assistant").length).toBe(3);
  });

  it("resume: a new query({ resume }) replays the deferred call through the hook first, exactly once", async () => {
    const sdk = createFakeSdk(twoCommands);
    let first = true;
    const hook: SdkHookCallback = async (i) => {
      const cmd = (i.tool_input as { command: string }).command;
      if (first && cmd.includes("L2-DONE")) {
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "defer" } };
      }
      return allow();
    };
    const step1 = await collect(
      sdk.query({ prompt: "go", options: { hooks: { PreToolUse: [{ hooks: [hook] }] } } }),
    );
    const r1 = step1.at(-1);
    if (r1?.type !== "result") throw new Error("unreachable");

    first = false;
    const step2 = await collect(
      sdk.query({
        prompt: "Approval granted by human. Continue.",
        options: { resume: r1.session_id, hooks: { PreToolUse: [{ hooks: [hook] }] } },
      }),
    );
    // step2-resume.mjs: the hook receives the same L2 command again, then the agent replies DONE
    const types = step2.map((m) => m.type);
    expect(types).toEqual(["system", "user", "assistant", "result"]);
    const r2 = step2.at(-1);
    if (r2?.type !== "result" || r2.subtype !== "success") throw new Error("unreachable");
    expect(r2.result).toBe("DONE");
    expect(r2.session_id).toBe(r1.session_id);
    const session = sdk.sessions.get(r1.session_id);
    const l2Calls = session?.toolCalls.filter((c) =>
      (c.input.command as string).includes("L2-DONE"),
    );
    expect(l2Calls?.map((c) => [c.hookDecision, c.executed])).toEqual([
      ["defer", false],
      ["allow", true],
    ]);
    expect(session?.deferred).toBeUndefined();
  });
});

describe("canUseTool (spikes/s0/test-b/short-wait.mjs)", () => {
  it("is called as (toolName, input, { signal }) when the hook gives no decision, and the fake waits for it", async () => {
    const sdk = createFakeSdk([
      { type: "tool_call", name: "Bash", input: { command: "echo ok" }, result: "ok" },
      { type: "end", summary: "DONE" },
    ]);
    let waited: { toolName: string; aborted: boolean } | null = null;
    const order: string[] = [];
    const msgs = await collect(
      sdk.query({
        prompt: "go",
        options: {
          canUseTool: async (toolName, input, { signal }) => {
            await new Promise((r) => setTimeout(r, 20));
            waited = { toolName, aborted: signal.aborted };
            order.push("callback");
            return { behavior: "allow", updatedInput: input };
          },
        },
      }),
    );
    order.push("done");
    expect(waited).toEqual({ toolName: "Bash", aborted: false });
    expect(order).toEqual(["callback", "done"]);
    const session = [...sdk.sessions.values()][0];
    expect(session?.toolCalls[0]).toMatchObject({
      hookDecision: "none",
      callbackDecision: "allow",
      executed: true,
      result: "ok",
    });
    expect(msgs.at(-1)?.type).toBe("result");
  });

  it("deny from the callback becomes the tool result message", async () => {
    const sdk = createFakeSdk([
      { type: "tool_call", name: "Bash", input: { command: "x" }, result: "never" },
      { type: "end", summary: "" },
    ]);
    const msgs = await collect(
      sdk.query({
        prompt: "go",
        options: { canUseTool: async () => ({ behavior: "deny", message: "nope" }) },
      }),
    );
    const u = msgs.find((m) => m.type === "user");
    if (u?.type !== "user") throw new Error("unreachable");
    expect(u.message.content[0]).toMatchObject({ content: "nope", is_error: true });
  });

  it("is skipped when the hook already allowed, and fails closed when absent", async () => {
    const script: ScriptStep[] = [
      { type: "tool_call", name: "Bash", input: { command: "x" }, result: "ran" },
      { type: "end", summary: "" },
    ];
    let called = 0;
    const sdk = createFakeSdk(script);
    await collect(
      sdk.query({
        prompt: "go",
        options: {
          hooks: { PreToolUse: [{ hooks: [async () => allow()] }] },
          canUseTool: async () => {
            called += 1;
            return { behavior: "allow" };
          },
        },
      }),
    );
    expect(called).toBe(0);

    const sdk2 = createFakeSdk(script);
    const msgs = await collect(sdk2.query({ prompt: "go" }));
    const u = msgs.find((m) => m.type === "user");
    if (u?.type !== "user") throw new Error("unreachable");
    expect(u.message.content[0]?.is_error).toBe(true);
  });

  it("does not prompt for read-only tools, like the real SDK", async () => {
    const sdk = createFakeSdk([
      { type: "tool_call", name: "Read", input: { file_path: "/a" }, result: "contents" },
      { type: "end", summary: "" },
    ]);
    const msgs = await collect(sdk.query({ prompt: "go" }));
    const u = msgs.find((m) => m.type === "user");
    if (u?.type !== "user") throw new Error("unreachable");
    expect(u.message.content[0]).toMatchObject({ content: "contents" });
  });
});

describe("tool availability and permission defaults", () => {
  const script: ScriptStep[] = [
    { type: "tool_call", name: "WebFetch", input: { url: "https://x.test" }, result: "page" },
    { type: "tool_call", name: "Bash", input: { command: "x" }, result: "ran" },
    { type: "end", summary: "" },
  ];

  it("does not offer a disallowed tool: no hook, no execution, error tool_result", async () => {
    const sdk = createFakeSdk(script);
    const seen: string[] = [];
    const hook: SdkHookCallback = async (i) => {
      seen.push(i.tool_name);
      return allow();
    };
    const msgs = await collect(
      sdk.query({
        prompt: "go",
        options: {
          disallowedTools: ["WebFetch", "WebSearch"],
          hooks: { PreToolUse: [{ hooks: [hook] }] },
        },
      }),
    );
    // The real SDK removes the tool from the model's list; nothing downstream of the model runs.
    expect(seen).toEqual(["Bash"]);
    const users = msgs.filter((m) => m.type === "user");
    const first = users[0];
    if (first?.type !== "user") throw new Error("unreachable");
    expect(first.message.content[0]).toMatchObject({
      content: "tool WebFetch is not available",
      is_error: true,
    });
    const session = [...sdk.sessions.values()][0];
    expect(session?.toolCalls[0]).toMatchObject({
      name: "WebFetch",
      hookDecision: "none",
      unavailable: true,
      executed: false,
    });
    expect(session?.toolCalls[0]?.callbackDecision).toBeUndefined();
    expect(session?.toolCalls[1]).toMatchObject({ name: "Bash", executed: true, result: "ran" });
  });

  it("keeps tools outside allowedTools available", async () => {
    const sdk = createFakeSdk([
      { type: "tool_call", name: "Read", input: { file_path: "/a" }, result: "contents" },
      { type: "end", summary: "" },
    ]);
    let prompted = 0;
    const msgs = await collect(
      sdk.query({
        prompt: "go",
        options: {
          allowedTools: ["Bash"],
          canUseTool: async () => {
            prompted += 1;
            return { behavior: "allow" };
          },
        },
      }),
    );
    expect(prompted).toBe(0);
    const u = msgs.find((m) => m.type === "user");
    if (u?.type !== "user") throw new Error("unreachable");
    expect(u.message.content[0]).toMatchObject({
      content: "contents",
    });
    const session = [...sdk.sessions.values()][0];
    expect(session?.toolCalls[0]?.executed).toBe(true);
  });

  it("auto-allows named tools while prompting for other write tools", async () => {
    const sdk = createFakeSdk([
      { type: "tool_call", name: "Bash", input: {}, result: "ran" },
      { type: "tool_call", name: "Write", input: {}, result: "written" },
      { type: "end", summary: "" },
    ]);
    const prompted: string[] = [];
    const hooked: string[] = [];
    await collect(
      sdk.query({
        prompt: "go",
        options: {
          allowedTools: ["Bash"],
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  async (input) => {
                    hooked.push(input.tool_name);
                    return {};
                  },
                ],
              },
            ],
          },
          canUseTool: async (name) => {
            prompted.push(name);
            return { behavior: "allow" };
          },
        },
      }),
    );
    expect(hooked).toEqual(["Bash", "Write"]);
    expect(prompted).toEqual(["Write"]);
    expect([...sdk.sessions.values()][0]?.toolCalls.every((call) => call.executed)).toBe(true);
  });

  it.each(["deny", "defer", "ask"] as const)(
    "does not let allowedTools override a hook %s",
    async (decision) => {
      const sdk = createFakeSdk([{ type: "tool_call", name: "Bash", input: {}, result: "ran" }]);
      let prompted = 0;
      await collect(
        sdk.query({
          prompt: "go",
          options: {
            allowedTools: ["Bash"],
            hooks: {
              PreToolUse: [
                {
                  hooks: [
                    async () => ({
                      hookSpecificOutput: {
                        hookEventName: "PreToolUse",
                        permissionDecision: decision,
                      },
                    }),
                  ],
                },
              ],
            },
            canUseTool: async () => {
              prompted++;
              return { behavior: "deny", message: "blocked" };
            },
          },
        }),
      );
      expect(prompted).toBe(decision === "ask" ? 1 : 0);
      expect([...sdk.sessions.values()][0]?.toolCalls[0]?.executed).toBe(false);
    },
  );

  it.each([
    { tools: [], disallowedTools: [], expected: ["mcp__test__read"] },
    { tools: ["Read"], disallowedTools: [], expected: ["Read", "mcp__test__read"] },
    {
      tools: { type: "preset", preset: "claude_code" },
      disallowedTools: ["Bash"],
      expected: ["Read", "mcp__test__read"],
    },
  ] satisfies {
    tools: NonNullable<SdkQueryOptions["tools"]>;
    disallowedTools: string[];
    expected: string[];
  }[])(
    "filters built-ins independently of MCP and permission defaults: $expected",
    async ({ tools, disallowedTools, expected }) => {
      const sdk = createFakeSdk(
        ["Bash", "Read", "mcp__test__read"].map((name) => ({
          type: "tool_call",
          name,
          input: {},
          result: "ok",
        })),
      );
      const messages = await collect(
        sdk.query({
          prompt: "go",
          options: {
            tools,
            disallowedTools,
            allowedTools: ["Bash"],
            hooks: { PreToolUse: [{ hooks: [async () => allow()] }] },
          },
        }),
      );
      expect(messages[0]).toMatchObject({ tools: expected });
      expect(
        [...sdk.sessions.values()][0]?.toolCalls
          .filter((call) => call.executed)
          .map((call) => call.name),
      ).toEqual(expected);
    },
  );

  it("system/init reports the script's tools minus the disallowed ones", async () => {
    const sdk = createFakeSdk(script);
    const msgs = await collect(
      sdk.query({ prompt: "go", options: { disallowedTools: ["WebFetch"] } }),
    );
    const init = msgs[0];
    if (init?.type !== "system" || init.subtype !== "init") throw new Error("unreachable");
    expect(init.tools).toEqual(["Bash"]);
  });
});

describe("hook timeout and hook failure (real CLI: no decision, fall through)", () => {
  const oneBash: ScriptStep[] = [
    { type: "tool_call", name: "Bash", input: { command: "x" }, result: "ran" },
    { type: "end", summary: "" },
  ];

  it("a hook that throws yields no decision and falls through to canUseTool", async () => {
    const sdk = createFakeSdk(oneBash);
    const msgs = await collect(
      sdk.query({
        prompt: "go",
        options: {
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  async () => {
                    throw new Error("hook exploded");
                  },
                ],
              },
            ],
          },
          canUseTool: async () => ({ behavior: "allow" }),
        },
      }),
    );
    expect(msgs.at(-1)?.type).toBe("result");
    const session = [...sdk.sessions.values()][0];
    expect(session?.toolCalls[0]).toMatchObject({
      hookDecision: "none",
      callbackDecision: "allow",
      executed: true,
      result: "ran",
    });
    expect(session?.toolCalls[0]?.hookError).toContain("hook exploded");
  });

  it("a hook past the matcher timeout is cancelled and canUseTool decides", async () => {
    const sdk = createFakeSdk(oneBash);
    const msgs = await collect(
      sdk.query({
        prompt: "go",
        options: {
          hooks: {
            PreToolUse: [{ timeout: 0.02, hooks: [() => new Promise<SdkHookOutput>(() => {})] }],
          },
          canUseTool: async () => ({ behavior: "deny", message: "timed out, denying" }),
        },
      }),
    );
    const u = msgs.find((m) => m.type === "user");
    if (u?.type !== "user") throw new Error("unreachable");
    expect(u.message.content[0]).toMatchObject({
      content: "timed out, denying",
      is_error: true,
    });
    const session = [...sdk.sessions.values()][0];
    expect(session?.toolCalls[0]?.hookTimedOut).toBe(true);
    expect(session?.toolCalls[0]?.hookDecision).toBe("none");
    expect(session?.toolCalls[0]?.executed).toBe(false);
  });

  it("a hook that throws with no canUseTool fails closed instead of failing the query", async () => {
    const sdk = createFakeSdk(oneBash);
    const msgs = await collect(
      sdk.query({
        prompt: "go",
        options: {
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  async () => {
                    throw new Error("hook exploded");
                  },
                ],
              },
            ],
          },
        },
      }),
    );
    const u = msgs.find((m) => m.type === "user");
    if (u?.type !== "user") throw new Error("unreachable");
    expect(u.message.content[0]?.is_error).toBe(true);
    expect(msgs.at(-1)?.type).toBe("result");
    const session = [...sdk.sessions.values()][0];
    expect(session?.toolCalls[0]?.executed).toBe(false);
  });

  it("a later hook still decides after an earlier one fails", async () => {
    const sdk = createFakeSdk(oneBash);
    await collect(
      sdk.query({
        prompt: "go",
        options: {
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  async () => {
                    throw new Error("first hook exploded");
                  },
                  async () => allow(),
                ],
              },
            ],
          },
        },
      }),
    );
    const session = [...sdk.sessions.values()][0];
    expect(session?.toolCalls[0]).toMatchObject({ hookDecision: "allow", executed: true });
  });
});

describe("AbortSignal", () => {
  it("throws AbortError while waiting on the callback", async () => {
    const sdk = createFakeSdk([
      { type: "tool_call", name: "Bash", input: { command: "x" }, result: "" },
      { type: "end", summary: "" },
    ]);
    const abortController = new AbortController();
    const gen = sdk.query({
      prompt: "go",
      options: {
        abortController,
        canUseTool: () =>
          new Promise((resolve) => {
            setTimeout(() => abortController.abort(), 10);
            setTimeout(() => resolve({ behavior: "allow" }), 1000);
          }),
      },
    });
    await expect(collect(gen)).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("in-process MCP tools (tool + createSdkMcpServer)", () => {
  it("runs the registered handler for mcp__<server>__<tool> and returns its text", async () => {
    const sdk = createFakeSdk([
      { type: "tool_call", name: "mcp__deskmates__thread_post", input: { body: "hello" } },
      { type: "end", summary: "" },
    ]);
    const posted: string[] = [];
    const schema = { body: { _output: "" as string } };
    const def = sdk.tool("thread_post", "Post to the thread", schema, async (args) => {
      posted.push(args.body);
      return { content: [{ type: "text", text: "posted" }] };
    });
    const server = sdk.createSdkMcpServer({ name: "deskmates", tools: [def] });
    const msgs = await collect(
      sdk.query({
        prompt: "go",
        options: {
          mcpServers: { deskmates: server },
          hooks: { PreToolUse: [{ hooks: [async () => allow()] }] },
        },
      }),
    );
    expect(posted).toEqual(["hello"]);
    const u = msgs.find((m) => m.type === "user");
    if (u?.type !== "user") throw new Error("unreachable");
    expect(u.message.content[0]).toMatchObject({ content: "posted" });
  });
});

// A tool that ran and failed is not a denial: the model sees the error and tries something else.
// The case the sidecar needs is a browser `ref` from a snapshot the session no longer has.
describe("a scripted tool result that is an error (ScriptStep.isError)", () => {
  it("executes the call and marks the tool_result is_error", async () => {
    const sdk = createFakeSdk([
      {
        type: "tool_call",
        name: "mcp__browser__browser_click",
        input: { element: "Submit order button", ref: "f1e23" },
        result: "Error: Ref f1e23 not found in the current page snapshot",
        isError: true,
      },
      { type: "end", summary: "" },
    ]);
    const msgs = await collect(
      sdk.query({
        prompt: "go",
        options: { hooks: { PreToolUse: [{ hooks: [async () => allow()] }] } },
      }),
    );
    const u = msgs.find((m) => m.type === "user");
    if (u?.type !== "user") throw new Error("unreachable");
    expect(u.message.content[0]).toMatchObject({
      type: "tool_result",
      content: "Error: Ref f1e23 not found in the current page snapshot",
      is_error: true,
    });
    const session = [...sdk.sessions.values()][0];
    expect(session?.toolCalls[0]).toMatchObject({ hookDecision: "allow", executed: true });
  });
});

// Context observability (M3 context plan, Phase 1): per-turn usage on assistant messages and the
// compaction boundary, in the SDK 0.3.278 shapes (`SDKAssistantMessage.message.usage`,
// `SDKCompactBoundaryMessage.compact_metadata`, `PreCompactHookInput`).
describe("per-turn usage and compaction", () => {
  it("reports a step's usage on its assistant message and sums it into the result", async () => {
    const sdk = createFakeSdk([
      { type: "text", text: "one", usage: { inputTokens: 1200, cacheReadTokens: 800 } },
      { type: "text", text: "two", usage: { inputTokens: 50, outputTokens: 9 } },
      { type: "end", summary: "two" },
    ]);
    const msgs = await collect(sdk.query({ prompt: "go", options: { model: "m" } }));
    const usages = msgs.flatMap((m) => (m.type === "assistant" ? [m.message.usage] : []));
    expect(usages.map((u) => [u.input_tokens, u.output_tokens, u.cache_read_input_tokens])).toEqual(
      [
        [1200, 5, 800],
        [50, 9, 0],
      ],
    );
    const result = msgs.at(-1);
    if (result?.type !== "result") throw new Error("expected a result");
    expect(result.modelUsage.m?.inputTokens).toBe(1250);
    expect(result.modelUsage.m?.cacheReadInputTokens).toBe(800);
  });

  it("runs PreCompact hooks, then emits compact_boundary; a throwing hook does not stop it", async () => {
    const sdk = createFakeSdk([
      { type: "text", text: "before" },
      { type: "compact", trigger: "auto", preTokens: 150_000, postTokens: 12_000 },
      { type: "compact", preTokens: 90_000 },
      { type: "end", summary: "after" },
    ]);
    const seen: SdkPreCompactHookInput[] = [];
    const msgs = await collect(
      sdk.query({
        prompt: "go",
        options: {
          cwd: "/work",
          hooks: {
            PreCompact: [
              {
                hooks: [
                  async (input) => {
                    seen.push(input);
                    throw new Error("archive failed");
                  },
                ],
              },
            ],
          },
        },
      }),
    );
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({
      hook_event_name: "PreCompact",
      trigger: "auto",
      custom_instructions: null,
      cwd: "/work",
    });
    expect(typeof seen[0]?.transcript_path).toBe("string");
    const boundaries = msgs.flatMap((m) =>
      m.type === "system" && m.subtype === "compact_boundary" ? [m.compact_metadata] : [],
    );
    expect(boundaries).toEqual([
      { trigger: "auto", pre_tokens: 150_000, post_tokens: 12_000 },
      { trigger: "auto", pre_tokens: 90_000 },
    ]);
    expect(msgs.at(-1)).toMatchObject({ type: "result", result: "after" });
  });
});
