// T0: the channel a composite submit binds under (issue #21, part 4).
import { describe, expect, it } from "vitest";
import { isChannelName } from "./channel.js";
import { agentChannel } from "./submit.js";

describe("agentChannel", () => {
  it("names the caller", () => {
    expect(agentChannel({ kind: "service", servicePrincipalId: "svc_1" })).toBe("agent:svc_1");
    expect(agentChannel({ kind: "user", userId: "usr_1" })).toBe("agent:user:usr_1");
    expect(agentChannel({ kind: "operator" })).toBe("agent:operator");
  });

  it("is never a channel name POST /api/threads accepts, so no other client can bind one", () => {
    for (const caller of [
      { kind: "service", servicePrincipalId: "svc_1" },
      { kind: "user", userId: "usr_1" },
      { kind: "operator" },
    ] as const)
      expect(isChannelName(agentChannel(caller))).toBe(false);
  });
});
