// T0 (#61 L11): a failed channel operation tells the operator to check the Gateway log, so the
// log line carries the error's code and a bounded message, with secret-shaped text redacted.

import { describe, expect, it } from "vitest";
import { ChannelManager, channelErrorLogFields } from "./channel-manager.js";

type Log = [string, string, Readonly<Record<string, unknown>> | undefined];

function manager(logs: Log[]): ChannelManager {
  // Construction runs no SQL; safeError only logs, so no other dependency is reached.
  return new ChannelManager({
    db: {},
    stateRoot: "/nonexistent",
    log: (level: string, message: string, data?: Readonly<Record<string, unknown>>) =>
      logs.push([level, message, data]),
  } as unknown as ConstructorParameters<typeof ChannelManager>[0]);
}

describe("channel error log", () => {
  it("logs the message and code of a failed operation, redacted, not only its name", () => {
    const logs: Log[] = [];
    const error = Object.assign(
      new Error("provider answered 401 for https://graph.example.test/v1?access_token=abc123xyz"),
      { code: "ECONNRESET" },
    );
    const shown = (manager(logs) as unknown as { safeError(e: unknown): string }).safeError(error);
    expect(shown).toBe("Channel operation failed. Check the Gateway log and try again.");
    expect(logs).toEqual([
      [
        "warn",
        "channel operation failed",
        {
          error: "Error",
          code: "ECONNRESET",
          message:
            "provider answered 401 for https://graph.example.test/v1?access_token=[redacted]",
        },
      ],
    ]);
  });

  it("bounds the message and keeps a non-Error opaque", () => {
    expect(channelErrorLogFields(new TypeError("x".repeat(2_000)))).toEqual({
      error: "TypeError",
      message: "x".repeat(500),
    });
    expect(channelErrorLogFields("Bearer secret-token-value")).toEqual({ error: "unknown" });
  });
});
