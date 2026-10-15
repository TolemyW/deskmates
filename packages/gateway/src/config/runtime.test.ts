// T0: `DEFAULT_RUNTIME` (ADR-0042 decision 1).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readRuntimeConfig } from "./runtime.js";

describe("DEFAULT_RUNTIME", () => {
  it("is the Claude Agent SDK when unset or empty, so existing installs run as before", () => {
    expect(readRuntimeConfig({})).toEqual({ defaultRuntime: "claude-agent-sdk" });
    expect(readRuntimeConfig({ DEFAULT_RUNTIME: "  " })).toEqual({
      defaultRuntime: "claude-agent-sdk",
    });
  });

  it("accepts the two runtimes the sidecar hosts", () => {
    expect(readRuntimeConfig({ DEFAULT_RUNTIME: "openai-agents" })).toEqual({
      defaultRuntime: "openai-agents",
    });
    expect(readRuntimeConfig({ DEFAULT_RUNTIME: "claude-agent-sdk" })).toEqual({
      defaultRuntime: "claude-agent-sdk",
    });
  });

  it("fails startup on anything else", () => {
    expect(() => readRuntimeConfig({ DEFAULT_RUNTIME: "codex" })).toThrow(/DEFAULT_RUNTIME/);
  });

  it("is documented in .env.example", () => {
    const example = readFileSync(new URL("../../../../.env.example", import.meta.url), "utf8");
    expect(example).toMatch(/^DEFAULT_RUNTIME=/m);
  });
});
