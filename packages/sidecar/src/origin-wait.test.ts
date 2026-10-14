import type { BrowserOriginRequest, BrowserOriginResponse, RunId } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { waitForBrowserOrigin } from "./origin-wait.js";

const runId = "run-1" as RunId;

function response(over: Partial<BrowserOriginResponse> = {}): BrowserOriginResponse {
  return { type: "browser_origin_result", runId, granted: false, ...over };
}

describe("waitForBrowserOrigin", () => {
  it("polls only origin_busy and returns the eventual grant", async () => {
    const requests: BrowserOriginRequest[] = [];
    const replies = [
      response({ waitReason: "origin_busy", retryAfterMs: 4 }),
      response({ granted: true, origin: "https://ops.test" }),
    ];
    const sleeps: number[] = [];
    const result = await waitForBrowserOrigin("https://ops.test", {
      runId,
      deadlineAt: "2026-09-23T10:01:00.000Z",
      now: () => new Date("2026-09-23T10:00:00.000Z"),
      sleep: async (ms) => void sleeps.push(ms),
      client: {
        browserOrigin: async (req) => {
          requests.push(req);
          return replies.shift() as BrowserOriginResponse;
        },
      },
    });
    expect(result.granted).toBe(true);
    expect(requests.map((req) => req.op)).toEqual(["acquire", "acquire"]);
    expect(sleeps).toEqual([4]);
  });

  it.each(["human", "lease_lost"] as const)("does not poll %s", async (waitReason) => {
    let calls = 0;
    const result = await waitForBrowserOrigin("https://ops.test", {
      runId,
      deadlineAt: "2026-09-23T10:01:00.000Z",
      now: () => new Date("2026-09-23T10:00:00.000Z"),
      client: {
        browserOrigin: async () => {
          calls++;
          return response({ waitReason });
        },
      },
    });
    expect(result.waitReason).toBe(waitReason);
    expect(calls).toBe(2); // response plus best-effort pending-entry cleanup
  });

  it("releases its queue entry on abort", async () => {
    const controller = new AbortController();
    const requests: BrowserOriginRequest[] = [];
    await expect(
      waitForBrowserOrigin("https://ops.test", {
        runId,
        deadlineAt: "2026-09-23T10:01:00.000Z",
        now: () => new Date("2026-09-23T10:00:00.000Z"),
        signal: controller.signal,
        sleep: async () => controller.abort(),
        client: {
          browserOrigin: async (req) => {
            requests.push(req);
            return req.op === "release"
              ? response({ granted: true })
              : response({ waitReason: "origin_busy" });
          },
        },
      }),
    ).rejects.toThrow("cancelled");
    expect(requests.map((req) => req.op)).toEqual(["acquire", "release"]);
  });

  it("does not contact the Gateway after the absolute deadline", async () => {
    let calls = 0;
    await expect(
      waitForBrowserOrigin("https://ops.test", {
        runId,
        deadlineAt: "2026-09-23T10:00:00.000Z",
        now: () => new Date("2026-09-23T10:00:00.001Z"),
        client: {
          browserOrigin: async () => {
            calls++;
            return response();
          },
        },
      }),
    ).rejects.toThrow("deadline");
    expect(calls).toBe(1); // best-effort release only
  });

  it("aborts a currently hanging acquire at the absolute deadline", async () => {
    const started = Date.now();
    const requests: BrowserOriginRequest[] = [];
    await expect(
      waitForBrowserOrigin("https://ops.test", {
        runId,
        deadlineAt: new Date(Date.now() + 20).toISOString(),
        client: {
          browserOrigin: async (req, signal) => {
            requests.push(req);
            if (req.op === "release") return await new Promise<BrowserOriginResponse>(() => {});
            return await new Promise<BrowserOriginResponse>((_resolve, reject) =>
              signal?.addEventListener("abort", () => reject(new Error("aborted fetch")), {
                once: true,
              }),
            );
          },
        },
      }),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(500);
    expect(requests.map((req) => req.op)).toEqual(["acquire", "release"]);
  });

  it("releases a grant that arrives after the deadline instead of dispatching", async () => {
    let now = new Date("2026-09-23T10:00:00.000Z");
    const requests: BrowserOriginRequest[] = [];
    await expect(
      waitForBrowserOrigin("https://ops.test", {
        runId,
        deadlineAt: "2026-09-23T10:00:01.000Z",
        now: () => now,
        client: {
          browserOrigin: async (req) => {
            requests.push(req);
            if (req.op === "acquire") now = new Date("2026-09-23T10:00:02.000Z");
            return response({ granted: true, ...(req.origin ? { origin: req.origin } : {}) });
          },
        },
      }),
    ).rejects.toThrow("deadline");
    expect(requests.map((req) => req.op)).toContain("release");
  });
});
