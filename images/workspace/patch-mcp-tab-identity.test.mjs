import { describe, expect, it } from "vitest";
import { patchTabIdentity } from "./patch-mcp-tab-identity.mjs";

describe("pinned MCP identity shim", () => {
  it("fails closed on an unreviewed dependency rather than weakening its modal guard", () => {
    expect(() => patchTabIdentity("unexpected MCP source")).toThrow("Unsupported MCP core bundle");
  });
});
