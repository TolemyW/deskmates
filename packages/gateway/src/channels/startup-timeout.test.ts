// A restore can wait 15 seconds for Telegram identity verification. Fastify's
// default 10-second ready deadline must not terminate the entire Gateway first.
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGateway } from "../index.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { testConfig } from "../test-support/harness.js";
import { ChannelManager } from "./channel-manager.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Gateway channel restore startup budget", () => {
  it("waits for a bounded provider restore beyond ten seconds, then serves health", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(ChannelManager.prototype, "initialize").mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 15_000)),
    );
    const app = buildGateway(testConfig(), new FakeProvider(), { startCron: false });
    let result: string | undefined;
    const ready = app.ready().then(
      () => {
        result = "ready";
      },
      (error) => {
        result = error.code;
      },
    );
    try {
      await vi.advanceTimersByTimeAsync(12_000);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(3_001);
      await ready;
      expect(result).toBe("ready");
      expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("still fails a provider that never finishes instead of disabling startup timeouts", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(ChannelManager.prototype, "initialize").mockImplementation(
      () => new Promise(() => {}),
    );
    const app = buildGateway(testConfig(), new FakeProvider(), { startCron: false });
    let result: string | undefined;
    const ready = app.ready().then(
      () => {
        result = "ready";
      },
      (error) => {
        result = error.code;
      },
    );
    try {
      await vi.advanceTimersByTimeAsync(59_999);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(2);
      await ready;
      expect(result).toBe("FST_ERR_HOOK_TIMEOUT");
    } finally {
      await app.close();
    }
  });
});
