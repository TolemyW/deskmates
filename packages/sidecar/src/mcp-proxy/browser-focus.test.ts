import { describe, expect, it } from "vitest";
import { PREPARE_FOCUS_CODE, prepareBrowserFocus } from "./browser-focus.js";

const result = (value: unknown) => ({
  content: [{ type: "text", text: `### Result\n${JSON.stringify(value)}\n` }],
});

describe("browser background interaction preparation", () => {
  it("requires success for the exact leased target", async () => {
    await expect(
      prepareBrowserFocus(async () => result({ tabId: "own", ready: true }), "own"),
    ).resolves.toBeUndefined();
    for (const value of [{ tabId: "peer", ready: true }, { tabId: "own", ready: false }, null]) {
      await expect(prepareBrowserFocus(async () => result(value), "own")).rejects.toThrow(
        "no action was dispatched",
      );
    }
    await expect(
      prepareBrowserFocus(
        async () => ({ ...result({ tabId: "own", ready: true }), isError: true }),
        "own",
      ),
    ).rejects.toThrow("no action was dispatched");
  });

  it("keeps one CDP session alive across calls and discards a failed session before retry", async () => {
    let created = 0;
    let detached = 0;
    let fail = false;
    const commands: { method: string; params: unknown }[] = [];
    const page = {
      context: () => ({
        newCDPSession: async () => {
          created += 1;
          return {
            send: async (method: string, params?: unknown) => {
              commands.push({ method, params });
              if (fail) throw new Error("session closed");
              return { targetInfo: { targetId: "own" } };
            },
            detach: async () => {
              detached += 1;
            },
          };
        },
      }),
    };
    // Execute the exact constant that crosses the RPC boundary, against a tiny protocol double.
    // There is no model, real SDK, browser or untrusted input in this T0 test.
    const run = new Function(`return (${PREPARE_FOCUS_CODE});`)() as (
      value: typeof page,
      expectedTabId: string,
    ) => Promise<{ tabId: string; ready: boolean }>;
    expect(await run(page, "own")).toEqual({ tabId: "own", ready: true });
    await run(page, "own");
    expect(created).toBe(1);
    expect(detached).toBe(0);
    expect(
      commands.filter((entry) => entry.method === "Emulation.setFocusEmulationEnabled"),
    ).toEqual(
      Array.from({ length: 2 }, () => ({
        method: "Emulation.setFocusEmulationEnabled",
        params: { enabled: true },
      })),
    );
    fail = true;
    await expect(run(page, "own")).rejects.toThrow("session closed");
    expect(detached).toBe(1);
    fail = false;
    await run(page, "own");
    expect(created).toBe(2);
    const applied = commands.filter(
      (entry) => entry.method === "Emulation.setFocusEmulationEnabled",
    ).length;
    await expect(run(page, "peer")).rejects.toThrow("target changed");
    expect(
      commands.filter((entry) => entry.method === "Emulation.setFocusEmulationEnabled"),
    ).toHaveLength(applied);
  });
});
