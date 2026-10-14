// T0: which threads are a read-only Web mirror of an external chat channel (ADR-0017 amendment 2).

import { describe, expect, it } from "vitest";
import { WEB_CHANNEL, WHATSAPP_CHANNEL, isChannelMirrorThread } from "./channel.js";
import { agentChannel } from "./submit.js";

describe("isChannelMirrorThread", () => {
  it("is true for a thread owned by an external chat channel", () => {
    expect(isChannelMirrorThread({ channel: WHATSAPP_CHANNEL })).toBe(true);
    expect(isChannelMirrorThread({ channel: "telegram" })).toBe(true);
  });

  it("is false for the operator UI's own threads", () => {
    expect(isChannelMirrorThread({ channel: WEB_CHANNEL })).toBe(false);
  });

  it("is false for an agent-client submission thread, which its submitter keeps writing to", () => {
    for (const channel of [
      agentChannel({ kind: "operator" }),
      agentChannel({ kind: "user", userId: "usr_1" }),
      agentChannel({ kind: "service", servicePrincipalId: "svc_1" }),
    ]) {
      expect(isChannelMirrorThread({ channel }), channel).toBe(false);
    }
  });
});
