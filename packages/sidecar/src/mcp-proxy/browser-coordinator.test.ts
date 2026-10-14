import type { PhaseTimingSample, RunId } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import type { BrowserState, BrowserTab } from "../browser-state.js";
import { PREPARE_CAPTURE_CODE } from "./browser-capture-focus.js";
import {
  type BrowserCall,
  BrowserCoordinator,
  type BrowserRpc,
  probeTabs,
} from "./browser-coordinator.js";
import { PREPARE_FOCUS_CODE } from "./browser-focus.js";
import { PhaseTimer, type TimingRecorder } from "./timing.js";

function fixture(
  saved?: BrowserState,
  originV2 = false,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void> = async () => {},
  timing?: TimingRecorder,
  screenSlot?: number,
) {
  const runId = "run-1" as RunId;
  let persisted = saved;
  let tabs: BrowserTab[] = saved
    ? structuredClone(saved.tabs)
    : [{ id: "operator", url: "about:blank", current: true }];
  let human = false;
  let blocked: string | undefined;
  let epoch = 0;
  const calls: BrowserCall[] = [];
  const leases: (string | undefined)[] = [];
  const originRequests: { op: string; origin?: string }[] = [];
  const originReplies: Array<{
    granted: boolean;
    waitReason?: "origin_busy" | "human" | "lease_lost";
    retryAfterMs?: number;
  }> = [];
  const rpc: BrowserRpc = async (call) => {
    calls.push(call);
    if (
      typeof call.arguments.code === "string" &&
      call.arguments.code.includes(PREPARE_FOCUS_CODE)
    ) {
      return {
        content: [
          {
            type: "text",
            text: `### Result\n${JSON.stringify({ tabId: tabs.find((tab) => tab.current)?.id, ready: true })}\n`,
          },
        ],
      };
    }
    if (
      typeof call.arguments.code === "string" &&
      call.arguments.code.includes("Target.createTarget")
    ) {
      const targetId = `window-${calls.length}`;
      tabs.push({ id: targetId, url: "about:blank", current: false });
      // Another run can create a target between creation and our discovery probe.
      tabs.push({ id: `other-${calls.length}`, url: "about:blank", current: false });
      return { content: [{ type: "text", text: `### Result\n${JSON.stringify({ targetId })}\n` }] };
    }
    const { action, index } = call.arguments;
    if (call.name === "browser_tabs") {
      if (action === "new") {
        tabs = tabs.map((t) => ({ ...t, current: false }));
        tabs.push({ id: `created-${calls.length}`, url: "about:blank", current: true });
      }
      if (action === "select") tabs = tabs.map((t, i) => ({ ...t, current: i === index }));
      if (action === "close") {
        const closing = index ?? tabs.findIndex((t) => t.current);
        tabs = tabs.filter((_, i) => i !== closing);
        if (!tabs.some((t) => t.current) && tabs[0]) tabs[0].current = true;
      }
    }
    return { content: [{ type: "text", text: `### Result\n${JSON.stringify({ tabs })}\n` }] };
  };
  const create = () =>
    new BrowserCoordinator(
      {
        runId,
        ...(screenSlot === undefined ? {} : { screenSlot }),
        gatewayBaseUrl: "http://test",
        token: "test",
        statePath: "/state",
        ...(originV2 ? { mode: "origin-v2" as const, deadlineAt: "2026-09-23T10:05:00.000Z" } : {}),
      },
      {
        now: () => new Date("2026-09-23T10:00:00.000Z"),
        sleep,
        ...(timing ? { timing } : {}),
        read: async () => persisted && JSON.stringify(persisted),
        write: async (state) => {
          persisted = structuredClone(state);
        },
        client: {
          browserLock: async (req) => {
            leases.push(req.tabId);
            return {
              type: "browser_lock_result",
              runId: req.runId,
              granted: !human && (!blocked || req.tabId !== blocked),
              epoch,
              waitMessage: "wait",
            };
          },
          browserOrigin: async (req) => {
            originRequests.push({ op: req.op, ...(req.origin ? { origin: req.origin } : {}) });
            const reply = originReplies.shift() ?? { granted: true };
            return {
              type: "browser_origin_result",
              runId,
              ...reply,
              ...(reply.granted && req.origin ? { origin: req.origin } : {}),
            };
          },
        },
      },
    );
  const coordinator = create();
  const execute = async (call: BrowserCall) => {
    await rpc(await coordinator.before(call, rpc));
    await coordinator.after(call, rpc);
  };
  return {
    coordinator,
    create,
    execute,
    rpc,
    calls,
    leases,
    originRequests,
    originReplies,
    state: () => persisted,
    tabs: () => tabs,
    setTabs: (next: BrowserTab[]) => {
      tabs = next;
    },
    human: () => {
      human = true;
      epoch++;
    },
    handback: () => {
      human = false;
    },
    block: (id: string) => {
      blocked = id;
    },
  };
}
const snapshot = { name: "browser_snapshot", arguments: {} };
const select = (index: number) => ({
  name: "browser_tabs",
  arguments: { action: "select", index },
});

describe("shared browser coordination", () => {
  it("creates a dedicated tab and leases its stable ID, even at the same URL", async () => {
    const f = fixture();
    await f.execute(snapshot);
    expect(f.coordinator.tabId()).not.toBe("operator");
    expect(f.tabs()).toHaveLength(2);
    expect(f.leases.at(-1)).toBe(f.coordinator.tabId());
    expect(f.state()?.tabs.every((t) => t.url === "about:blank")).toBe(true);
  });
  it("restores a saved target after a new MCP connection reorders pages", async () => {
    const f = fixture();
    await f.execute(snapshot);
    const own = f.coordinator.tabId();
    f.setTabs([...f.tabs()].reverse().map((t) => ({ ...t, current: t.id === "operator" })));
    const resumed = f.create();
    await resumed.before(snapshot, f.rpc);
    expect(f.tabs().find((t) => t.current)?.id).toBe(own);
    expect(f.calls.filter((c) => c.arguments.action === "new")).toHaveLength(1);
  });
  it("maps a previously visible index back to its identity after another page closes", async () => {
    const f = fixture({
      version: 1,
      runId: "run-1" as RunId,
      tabId: "own",
      tabs: [
        { id: "removed", url: "about:blank", current: false },
        { id: "target", url: "about:blank", current: false },
        { id: "own", url: "about:blank", current: true },
      ],
    });
    f.setTabs(f.tabs().slice(1));
    const prepared = await f.coordinator.before(select(1), f.rpc);
    expect(prepared.arguments.index).toBe(0);
    expect(f.leases.at(-1)).toBe("target");
  });
  it("never applies a stale index to a different target", async () => {
    const f = fixture();
    await f.execute(snapshot);
    f.setTabs(f.tabs().filter((t) => t.id !== "operator"));
    await expect(f.coordinator.before(select(0), f.rpc)).rejects.toThrow("no longer exists");
  });
  it("rejects a contended shared tab without dispatching the selection", async () => {
    const f = fixture();
    await f.execute(snapshot);
    f.block("operator");
    await expect(f.coordinator.before(select(0), f.rpc)).rejects.toThrow("wait");
    expect(f.tabs().find((t) => t.current)?.id).toBe(f.coordinator.tabId());
  });
  it("opens a fresh page and rejects the pending action when its own tab was closed", async () => {
    const f = fixture();
    await f.execute(snapshot);
    const old = f.coordinator.tabId();
    f.setTabs([{ id: "operator", url: "about:blank", current: true }]);
    await expect(
      f.coordinator.before({ name: "browser_click", arguments: { ref: "e1" } }, f.rpc),
    ).rejects.toThrow("was closed");
    expect(f.coordinator.tabId()).not.toBe(old);
    expect(f.calls.some((c) => c.name === "browser_click")).toBe(false);
  });
  it("closes only the run tab and does not reuse MCP's fallback page", async () => {
    const f = fixture();
    await f.execute(snapshot);
    await f.execute({ name: "browser_close", arguments: {} });
    expect(f.coordinator.tabId()).toBeUndefined();
    expect(f.tabs().map((t) => t.id)).toEqual(["operator"]);
    await f.execute(snapshot);
    expect(f.coordinator.tabId()).not.toBe("operator");
  });
  it("performs no probe, creation or action during human takeover", async () => {
    const f = fixture();
    f.human();
    await expect(f.coordinator.before(snapshot, f.rpc)).rejects.toThrow("wait");
    expect(f.calls).toEqual([]);
  });
  it("fences captures even after a take/handback cycle", async () => {
    const f = fixture();
    await f.execute(snapshot);
    const previous = f.coordinator.epoch();
    f.human();
    expect(await f.coordinator.canCapture(f.rpc)).toBe(false);
    f.handback();
    expect(await f.coordinator.canCapture(f.rpc)).toBe(true);
    expect(f.coordinator.epoch()).toBeGreaterThan(previous);
  });
  it("exposes the URL from the latest successful live capture fence", async () => {
    const f = fixture();
    await f.execute(snapshot);
    const tabId = f.coordinator.tabId() as string;
    f.setTabs([{ id: tabId, url: "https://example.test/redirected", current: true }]);
    expect(await f.coordinator.canCapture(f.rpc)).toBe(true);
    expect(f.coordinator.verifiedPage()).toEqual({
      tabId,
      url: "https://example.test/redirected",
      epoch: f.coordinator.epoch(),
    });
  });
  it("refreshes a changed origin and rejects the action for a new hook decision", async () => {
    const f = fixture();
    await f.execute(snapshot);
    f.setTabs(f.tabs().map((t) => (t.current ? { ...t, url: "https://changed.test" } : t)));
    await expect(f.coordinator.before(snapshot, f.rpc)).rejects.toThrow("origin changed");
    expect(f.state()?.tabs.find((t) => t.current)?.url).toBe("https://changed.test");
    await expect(f.coordinator.before(snapshot, f.rpc)).resolves.toEqual(snapshot);
  });
  it("fails closed when the diagnostic result cannot establish identity", () => {
    expect(() =>
      probeTabs({ content: [{ type: "text", text: '### Result\n{"tabs":[null]}\n' }] }),
    ).toThrow();
    expect(() =>
      probeTabs({ content: [{ type: "text", text: '### Result\n{"tabs":[]}\n' }] }),
    ).toThrow();
  });
});

describe("verified screenshot foreground preparation", () => {
  function captureRpc(f: ReturnType<typeof fixture>, onPrepare: () => void = () => {}) {
    let prepared = 0;
    const rpc: BrowserRpc = async (call) => {
      if (String(call.arguments.code).includes(PREPARE_CAPTURE_CODE)) {
        prepared += 1;
        const tab = f.tabs().find((entry) => entry.current);
        onPrepare();
        return {
          content: [
            {
              type: "text",
              text: `### Result\n${JSON.stringify({ tabId: tab?.id, url: tab?.url, ready: true })}\n`,
            },
          ],
        };
      }
      return f.rpc(call);
    };
    return { rpc, count: () => prepared };
  }

  it("moves foreground only for capture preparation, retaining exact page identity", async () => {
    const f = fixture();
    await f.execute(snapshot);
    const c = captureRpc(f);
    expect(await f.coordinator.canCapture(c.rpc)).toBe(true);
    expect(c.count()).toBe(0);
    const expected = f.coordinator.verifiedPage();
    expect(await f.coordinator.prepareCapture(c.rpc)).toBe(true);
    expect(c.count()).toBe(1);
    expect(f.coordinator.verifiedPage()).toEqual(expected);
    expect(await f.coordinator.canCapture(c.rpc)).toBe(true);
    expect(c.count()).toBe(1);
  });

  it("does not prepare the foreground while the human holds control", async () => {
    const f = fixture();
    await f.execute(snapshot);
    f.human();
    const c = captureRpc(f);
    expect(await f.coordinator.prepareCapture(c.rpc)).toBe(false);
    expect(c.count()).toBe(0);
    expect(f.coordinator.verifiedPage()).toBeUndefined();
  });

  it("rejects a take/handback during the initial probe before moving foreground", async () => {
    const f = fixture();
    await f.execute(snapshot);
    const c = captureRpc(f);
    const rpc: BrowserRpc = async (call) => {
      const result = await c.rpc(call);
      f.human();
      f.handback();
      return result;
    };
    expect(await f.coordinator.prepareCapture(rpc)).toBe(false);
    expect(c.count()).toBe(0);
  });

  it("rechecks control after the final identity probe in default tab mode", async () => {
    const f = fixture();
    await f.execute(snapshot);
    const c = captureRpc(f);
    let probes = 0;
    const rpc: BrowserRpc = async (call) => {
      const result = await c.rpc(call);
      if (!String(call.arguments.code).includes(PREPARE_CAPTURE_CODE) && ++probes === 2) {
        f.human();
        f.handback();
      }
      return result;
    };
    expect(await f.coordinator.prepareCapture(rpc)).toBe(false);
    expect(c.count()).toBe(1);
    expect(f.coordinator.verifiedPage()).toBeUndefined();
  });

  it.each(["takeover", "take-handback", "target", "url", "rpc-error"])(
    "rejects capture when %s changes during foreground preparation",
    async (change) => {
      const f = fixture();
      await f.execute(snapshot);
      const c = captureRpc(f, () => {
        if (change === "takeover" || change === "take-handback") f.human();
        if (change === "take-handback") f.handback();
        if (change === "target") f.setTabs([{ id: "peer", url: "about:blank", current: true }]);
        if (change === "url")
          f.setTabs(f.tabs().map((tab) => ({ ...tab, url: "https://changed.test" })));
        if (change === "rpc-error") throw new Error("disconnected");
      });
      expect(await f.coordinator.prepareCapture(c.rpc)).toBe(false);
      expect(c.count()).toBe(1);
      expect(f.coordinator.verifiedPage()).toBeUndefined();
    },
  );
});

describe("origin-v2 coordination", () => {
  it("uses an explicit navigation URL after live target verification", async () => {
    const f = fixture(undefined, true);
    await f.coordinator.before(
      { name: "browser_navigate", arguments: { url: "https://ops.test/tickets" } },
      f.rpc,
    );
    expect(f.originRequests).toEqual([
      { op: "acquire", origin: "https://ops.test" },
      { op: "renew", origin: "https://ops.test" },
      { op: "renew", origin: "https://ops.test" },
    ]);
  });

  it("renews the same origin and releases it before waiting on a different one", async () => {
    const f = fixture(undefined, true);
    await f.coordinator.before(
      { name: "browser_navigate", arguments: { url: "https://one.test/a" } },
      f.rpc,
    );
    await f.coordinator.before(
      { name: "browser_navigate", arguments: { url: "https://one.test/b" } },
      f.rpc,
    );
    await f.coordinator.before(
      { name: "browser_navigate", arguments: { url: "https://two.test/c" } },
      f.rpc,
    );
    expect(f.originRequests).toEqual([
      { op: "acquire", origin: "https://one.test" },
      { op: "renew", origin: "https://one.test" },
      { op: "renew", origin: "https://one.test" },
      { op: "renew", origin: "https://one.test" },
      { op: "renew", origin: "https://one.test" },
      { op: "renew", origin: "https://one.test" },
      { op: "release", origin: "https://one.test" },
      { op: "acquire", origin: "https://two.test" },
      { op: "renew", origin: "https://two.test" },
      { op: "renew", origin: "https://two.test" },
    ]);
  });

  it("polls origin_busy in the host and surfaces takeover without another poll", async () => {
    const busy = fixture(undefined, true);
    busy.originReplies.push(
      { granted: false, waitReason: "origin_busy", retryAfterMs: 1 },
      { granted: true },
    );
    await busy.coordinator.before(
      { name: "browser_navigate", arguments: { url: "https://ops.test" } },
      busy.rpc,
    );
    expect(busy.originRequests.map((request) => request.op)).toEqual([
      "acquire",
      "acquire",
      "renew",
      "renew",
    ]);

    const human = fixture(undefined, true);
    human.originReplies.push({ granted: false, waitReason: "human" });
    await expect(
      human.coordinator.before(
        { name: "browser_navigate", arguments: { url: "https://ops.test" } },
        human.rpc,
      ),
    ).rejects.toThrow("human is operating");
    expect(human.originRequests.map((request) => request.op)).toEqual(["acquire", "release"]);
  });

  it("records origin wait under the browser-before span", async () => {
    const samples: PhaseTimingSample[] = [];
    const f = fixture(
      undefined,
      true,
      async () => {},
      new PhaseTimer({ emit: (sample) => samples.push(sample), id: () => "origin-span" }),
    );
    f.originReplies.push(
      { granted: false, waitReason: "origin_busy", retryAfterMs: 1 },
      { granted: true },
    );
    await f.coordinator.before(
      { name: "browser_navigate", arguments: { url: "https://ops.test" } },
      f.rpc,
      "before-span",
    );
    expect(samples).toEqual([
      expect.objectContaining({
        phase: "origin_wait",
        edge: "start",
        spanId: "origin-span",
        parentSpanId: "before-span",
      }),
      expect.objectContaining({ phase: "origin_wait", edge: "end", outcome: "ok" }),
    ]);
  });

  it("keeps origin admission independent of timing observer exceptions", async () => {
    const throwingStart: TimingRecorder = {
      start: () => {
        throw new Error("observer start failed");
      },
    };
    const startFailure = fixture(undefined, true, async () => {}, throwingStart);
    await expect(
      startFailure.coordinator.before(
        { name: "browser_navigate", arguments: { url: "https://ops.test" } },
        startFailure.rpc,
        "before",
      ),
    ).resolves.toBeDefined();

    const throwingEnd: TimingRecorder = {
      start: () => ({
        spanId: "observer",
        end: () => {
          throw new Error("observer end failed");
        },
      }),
    };
    const endFailure = fixture(undefined, true, async () => {}, throwingEnd);
    await expect(
      endFailure.coordinator.before(
        { name: "browser_navigate", arguments: { url: "https://ops.test" } },
        endFailure.rpc,
        "before",
      ),
    ).resolves.toBeDefined();
  });

  it("re-probes and remaps a stable target after waiting in the origin queue", async () => {
    const saved: BrowserState = {
      version: 1,
      runId: "run-1" as RunId,
      tabId: "own",
      tabs: [
        { id: "own", url: "https://one.test", current: true },
        { id: "other", url: "https://two.test", current: false },
      ],
    };
    const f = fixture(saved, true, async () => {
      f.setTabs([
        { id: "other", url: "https://two.test", current: false },
        { id: "own", url: "https://one.test", current: true },
      ]);
    });
    f.originReplies.push(
      { granted: false, waitReason: "origin_busy", retryAfterMs: 1 },
      { granted: true },
    );
    const dispatched = await f.coordinator.before(
      { name: "browser_tabs", arguments: { action: "select", index: 1 } },
      f.rpc,
    );
    expect(dispatched.arguments.index).toBe(0);
  });

  it("rejects dispatch when the lease expires during focus preparation", async () => {
    const f = fixture(undefined, true);
    f.originReplies.push(
      { granted: true },
      { granted: true },
      { granted: false, waitReason: "lease_lost" },
    );
    await expect(
      f.coordinator.before(
        { name: "browser_navigate", arguments: { url: "https://ops.test" } },
        f.rpc,
      ),
    ).rejects.toThrow("lost before dispatch");
    expect(f.originRequests.map((request) => request.op)).toEqual(["acquire", "renew", "renew"]);
  });

  it("keeps lease loss sticky through later capture checks until a fresh admission", async () => {
    const f = fixture(
      {
        version: 1,
        runId: "run-1" as RunId,
        tabId: "own",
        tabs: [{ id: "own", url: "https://ops.test/tickets", current: true }],
      },
      true,
    );
    f.originReplies.push(
      { granted: true },
      { granted: true },
      { granted: true },
      { granted: false, waitReason: "lease_lost" },
    );
    const call = { name: "browser_click", arguments: { ref: "e1" } };
    await f.coordinator.before(call, f.rpc);
    await expect(f.coordinator.after(call, f.rpc, { content: [] })).rejects.toThrow(
      "may have completed",
    );
    const countAfterLoss = f.originRequests.length;
    await expect(f.coordinator.canCapture(f.rpc)).resolves.toBe(false);
    expect(f.originRequests).toHaveLength(countAfterLoss);
  });

  it("releases a stale origin after a cross-origin redirect and requires inspection", async () => {
    const saved: BrowserState = {
      version: 1,
      runId: "run-1" as RunId,
      tabId: "own",
      tabs: [{ id: "own", url: "https://one.test/start", current: true }],
    };
    const f = fixture(saved, true);
    const call = { name: "browser_click", arguments: { ref: "e1" } };
    await f.coordinator.before(call, f.rpc);
    f.setTabs([{ id: "own", url: "https://two.test/redirect", current: true }]);
    await expect(f.coordinator.after(call, f.rpc, { content: [] })).rejects.toThrow(
      "action may have completed",
    );
    expect(f.originRequests.at(-1)).toEqual({ op: "release", origin: "https://one.test" });
  });

  it("releases the origin after an MCP error result", async () => {
    const saved: BrowserState = {
      version: 1,
      runId: "run-1" as RunId,
      tabId: "own",
      tabs: [{ id: "own", url: "https://ops.test", current: true }],
    };
    const f = fixture(saved, true);
    const call = { name: "browser_click", arguments: { ref: "e1" } };
    await f.coordinator.before(call, f.rpc);
    await f.coordinator.after(call, f.rpc, { isError: true, content: [] });
    expect(f.originRequests.at(-1)).toEqual({ op: "release", origin: "https://ops.test" });
  });
});

it("does not dispatch onto MCP's fallback page when restoring selection fails", async () => {
  const f = fixture();
  await f.execute(snapshot);
  f.setTabs(f.tabs().map((tab) => ({ ...tab, current: tab.id === "operator" })));
  const failedSelection: BrowserRpc = async (call) =>
    call.arguments.action === "select"
      ? { isError: true, content: [{ type: "text", text: "target closed" }] }
      : f.rpc(call);
  await expect(f.coordinator.before(snapshot, failedSelection)).rejects.toThrow(
    "Could not restore",
  );
  expect(f.tabs().find((tab) => tab.current)?.id).toBe("operator");
});

it("requires the selected target to match even when a restore RPC reports success", async () => {
  const f = fixture();
  await f.execute(snapshot);
  f.setTabs(f.tabs().map((tab) => ({ ...tab, current: tab.id === "operator" })));
  const racedSelection: BrowserRpc = async (call) =>
    call.arguments.action === "select"
      ? { content: [{ type: "text", text: "selected" }] }
      : f.rpc(call);
  await expect(f.coordinator.before(snapshot, racedSelection)).rejects.toThrow("selection changed");
});

it("rejects capture attribution when its page closes and MCP selects another page", async () => {
  const f = fixture();
  await f.execute(snapshot);
  expect(await f.coordinator.canCapture(f.rpc)).toBe(true);
  f.setTabs([{ id: "operator", url: "about:blank", current: true }]);
  expect(await f.coordinator.canCapture(f.rpc)).toBe(false);
  expect(f.coordinator.tabId()).not.toBe("operator");
});

it("retains tab metadata after a failed close rather than reporting successful closure", async () => {
  const f = fixture();
  await f.execute(snapshot);
  const before = f.coordinator.tabId();
  const close = { name: "browser_close", arguments: {} };
  await f.coordinator.before(close, f.rpc);
  await f.coordinator.after(close, f.rpc, { isError: true });
  expect(f.coordinator.tabId()).toBe(before);
  expect(f.tabs()).toHaveLength(2);
});

it("rejects a successful selection that raced onto a different target", async () => {
  const f = fixture();
  await f.execute(snapshot);
  const before = f.coordinator.tabId();
  const call = select(0);
  await f.coordinator.before(call, f.rpc);
  // A competing page close changed the MCP index between probe and dispatch.
  await expect(f.coordinator.after(call, f.rpc, { content: [] })).rejects.toThrow(
    "selected browser tab changed",
  );
  expect(f.coordinator.tabId()).toBe(before);
});

it("does not adopt a fallback target when closing a different tab raced with page closure", async () => {
  const f = fixture();
  await f.execute(snapshot);
  const before = f.coordinator.tabId();
  const call = { name: "browser_tabs", arguments: { action: "close", index: 0 } };
  await f.coordinator.before(call, f.rpc);
  f.setTabs([{ id: "operator", url: "about:blank", current: true }]);
  await expect(f.coordinator.after(call, f.rpc, { content: [] })).rejects.toThrow(
    "selected browser tab changed",
  );
  expect(f.coordinator.tabId()).toBe(before);
});

it("never adopts an existing page when fresh tab creation reports success without a new target", async () => {
  const f = fixture();
  const noNewTarget: BrowserRpc = async (call) =>
    call.arguments.action === "new"
      ? { content: [{ type: "text", text: "created" }] }
      : f.rpc(call);
  await expect(f.coordinator.before(snapshot, noNewTarget)).rejects.toThrow(
    "new browser target could not be verified",
  );
  expect(f.coordinator.tabId()).toBeUndefined();
  expect(f.state()).toBeUndefined();
});

it("does not discard a still-existing run target after a success-shaped close response", async () => {
  const f = fixture();
  await f.execute(snapshot);
  const before = f.coordinator.tabId();
  const call = { name: "browser_close", arguments: {} };
  await f.coordinator.before(call, f.rpc);
  await expect(f.coordinator.after(call, f.rpc, { content: [] })).rejects.toThrow(
    "still present after close",
  );
  expect(f.coordinator.tabId()).toBe(before);
});

it("rejects a model-issued new-tab call that fell back to an existing target", async () => {
  const f = fixture();
  await f.execute(snapshot);
  const before = f.coordinator.tabId();
  const call = { name: "browser_tabs", arguments: { action: "new" } };
  await f.coordinator.before(call, f.rpc);
  await expect(f.coordinator.after(call, f.rpc, { content: [] })).rejects.toThrow(
    "new browser target could not be verified",
  );
  expect(f.coordinator.tabId()).toBe(before);
});

it("rejects a focus preparation result from a different target without dispatching the action", async () => {
  const f = fixture();
  await f.execute(snapshot);
  const expected = f.coordinator.tabId();
  const switched: BrowserRpc = async (call) =>
    typeof call.arguments.code === "string" && call.arguments.code.includes(PREPARE_FOCUS_CODE)
      ? { content: [{ type: "text", text: '### Result\n{"tabId":"peer","ready":true}\n' }] }
      : f.rpc(call);
  await expect(f.coordinator.before(snapshot, switched)).rejects.toThrow(
    "no action was dispatched",
  );
  expect(f.coordinator.tabId()).toBe(expected);
});

it("places initial and explicit new targets on the assigned screen without adopting a concurrent target", async () => {
  const f = fixture(undefined, false, undefined, undefined, 4);
  await f.execute(snapshot);
  expect(f.coordinator.tabId()).toMatch(/^window-/);
  const original = f.coordinator.tabId();
  await f.execute({ name: "browser_tabs", arguments: { action: "new" } });
  expect(f.coordinator.tabId()).toMatch(/^window-/);
  expect(f.coordinator.tabId()).not.toBe(original);
  const creations = f.calls.filter((c) => String(c.arguments.code).includes("Target.createTarget"));
  expect(creations).toHaveLength(2);
  expect(creations[0]?.arguments.code).toContain("left: 1280, top: 720");
  expect(f.calls.some((c) => c.name === "browser_tabs" && c.arguments.action === "new")).toBe(
    false,
  );
  f.human();
  const count = f.calls.length;
  await expect(f.execute(snapshot)).rejects.toThrow("wait");
  expect(f.calls).toHaveLength(count);
});

it("does not select or persist a target whose window placement failed", async () => {
  const f = fixture(undefined, false, undefined, undefined, 0);
  const rpc: BrowserRpc = async (call) =>
    String(call.arguments.code).includes("Target.createTarget")
      ? {
          isError: true,
          content: [{ type: "text", text: "Desktop window placement did not stabilize" }],
        }
      : f.rpc(call);
  await expect(f.coordinator.before(snapshot, rpc)).rejects.toThrow("no action was dispatched");
  expect(f.coordinator.tabId()).toBeUndefined();
  expect(f.state()).toBeUndefined();
  expect(
    f.calls.some((call) => call.name === "browser_tabs" && call.arguments.action !== "list"),
  ).toBe(false);
});

describe("modal-clearing tools", () => {
  // MCP 0.0.82 gates every tab tool except the one clearing the pending modal; a focus RPC
  // (browser_run_code_unsafe) would be rejected and leave the modal permanently in place.
  const modalCalls: BrowserCall[] = [
    { name: "browser_file_upload", arguments: { paths: ["/work/a.txt"] } },
    { name: "browser_handle_dialog", arguments: { accept: true } },
  ];
  for (const originV2 of [false, true])
    for (const call of modalCalls)
      it(`dispatches ${call.name} without page-code focus preparation (${originV2 ? "origin-v2" : "tab-v1"})`, async () => {
        const f = fixture(undefined, originV2);
        await f.execute(snapshot);
        const before = f.calls.length;
        await expect(f.coordinator.before(call, f.rpc)).resolves.toEqual(call);
        expect(f.calls.slice(before).some((c) => c.name === "browser_run_code_unsafe")).toBe(false);
      });
  for (const call of modalCalls)
    it(`re-checks live tab identity before dispatching ${call.name} in tab-v1`, async () => {
      const f = fixture();
      await f.execute(snapshot);
      const own = f.coordinator.tabId();
      let lists = 0;
      // The selected page changes after the first identity probe (e.g. while queued for the lock).
      const rpc: BrowserRpc = async (c) => {
        const result = await f.rpc(c);
        if (c.name === "browser_tabs" && c.arguments.action === "list" && ++lists === 1)
          f.setTabs(f.tabs().map((t) => ({ ...t, current: t.id !== own })));
        return result;
      };
      await expect(f.coordinator.before(call, rpc)).rejects.toThrow("no action was dispatched");
      expect(lists).toBe(2);
    });
});
