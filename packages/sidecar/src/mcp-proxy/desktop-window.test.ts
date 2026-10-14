import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { desktopWindowCode } from "./desktop-window.js";

const expected = { left: 1280, top: 720, width: 1280, height: 720, windowState: "normal" };

function fixture(reads: Array<Partial<typeof expected>>) {
  const calls: { method: string; params: unknown }[] = [];
  let detached = false;
  let waits = 0;
  let last: Partial<typeof expected> = {};
  const page = {
    waitForTimeout: async (ms: number) => {
      expect(ms).toBe(50);
      waits++;
    },
    context: () => ({
      newCDPSession: async () => ({
        send: async (method: string, params: unknown) => {
          calls.push({ method, params });
          if (method === "Target.createTarget") return { targetId: "ours" };
          if (method === "Browser.getWindowForTarget") return { windowId: 17 };
          if (method === "Browser.getWindowBounds") {
            last = reads.shift() ?? last;
            return { bounds: last };
          }
          return {};
        },
        detach: async () => {
          detached = true;
        },
      }),
    }),
  };
  const execute: (page: unknown) => Promise<{ targetId: string }> = runInNewContext(
    `(${desktopWindowCode(4)})`,
    {},
  );
  return { run: () => execute(page), calls, detached: () => detached, waits: () => waits };
}

it("repairs ignored bounds and a delayed cascade on the same target before accepting placement", async () => {
  const f = fixture([
    { ...expected, left: 2560 },
    expected,
    { ...expected, left: 0 },
    expected,
    expected,
    expected,
  ]);
  await expect(f.run()).resolves.toEqual({ targetId: "ours" });
  const sets = f.calls.filter((call) => call.method === "Browser.setWindowBounds");
  expect(sets).toHaveLength(3);
  expect(
    sets.every(
      (call) => JSON.stringify(call.params) === JSON.stringify({ windowId: 17, bounds: expected }),
    ),
  ).toBe(true);
  expect(f.waits()).toBe(6);
  expect(f.calls.some((call) => call.method === "Target.closeTarget")).toBe(false);
  expect(f.detached()).toBe(true);
});

it.each([
  { ...expected, left: 0 },
  { ...expected, top: 0 },
  { ...expected, width: 1279 },
  { ...expected, height: 799 },
  { ...expected, windowState: "maximized" },
])("fails closed and removes the new window when bounds stay wrong: %j", async (bounds) => {
  const f = fixture([bounds]);
  await expect(f.run()).rejects.toThrow("Desktop window placement did not stabilize");
  expect(f.waits()).toBe(20);
  expect(f.calls.filter((call) => call.method === "Target.closeTarget")).toEqual([
    { method: "Target.closeTarget", params: { targetId: "ours" } },
  ]);
  expect(f.detached()).toBe(true);
});

it.each([-1, 6, 0.5, Number.NaN])("rejects invalid screen slot %s", (slot) => {
  expect(() => desktopWindowCode(slot)).toThrow("Invalid desktop screen slot");
});
