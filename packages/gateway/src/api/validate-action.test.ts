// T0: the Gateway keeps the stable target an Always rule binds to (ADR-0002 amendment 3, A6) when
// it validates the sidecar's action and an operator's matcher, and refuses a malformed hash.

import { DeskmatesError } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { asRuleMatcher, asToolAction } from "./validate.js";

const HASH = "0123456789abcdef".repeat(4);

describe("inputSha256 (A6)", () => {
  it("is kept on an action and a matcher", () => {
    expect(
      asToolAction({ toolName: "SendMessage", input: {}, inputSha256: HASH }).inputSha256,
    ).toBe(HASH);
    expect(asRuleMatcher({ toolName: "SendMessage", inputSha256: HASH })).toEqual({
      toolName: "SendMessage",
      inputSha256: HASH,
    });
  });

  it("is refused unless it is a lower-case SHA-256 hex digest", () => {
    for (const bad of ["abc", HASH.toUpperCase(), 7])
      expect(() => asToolAction({ toolName: "X", input: {}, inputSha256: bad })).toThrow(
        DeskmatesError,
      );
  });
});
