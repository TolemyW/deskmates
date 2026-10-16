// T0: the `openai` upstream protocol (ADR-0044 decision 5) on top of ADR-0039's registry.

import { describe, expect, it } from "vitest";
import { ModelRegistry, parseModelUpstreams } from "./model-upstreams.js";

const OPENAI = JSON.stringify([
  { id: "oai", baseUrl: "http://10.0.0.5:8010", models: ["m-oai"], protocol: "openai" },
  { id: "ant", baseUrl: "http://10.0.0.5:8003", models: ["m-ant"], protocol: "anthropic" },
]);

describe("MODEL_UPSTREAMS protocol", () => {
  it("accepts openai beside anthropic and refuses anything else", () => {
    expect(parseModelUpstreams(OPENAI).map((u) => [u.id, u.protocol])).toEqual([
      ["oai", "openai"],
      ["ant", "anthropic"],
    ]);
    expect(() =>
      parseModelUpstreams(
        JSON.stringify([{ id: "x", baseUrl: "http://h", models: ["m"], protocol: "gemini" }]),
      ),
    ).toThrow(/protocol must be one of anthropic, openai/);
  });

  it("resolves each model with its upstream's protocol; the default upstream is anthropic", () => {
    const registry = new ModelRegistry({
      modelBaseUrl: "http://default.test",
      modelAuthToken: "t",
      modelUpstreams: parseModelUpstreams(OPENAI),
      defaultModel: "m-ant",
      cheapModel: "m-ant",
    });
    expect(registry.resolve("m-oai")).toMatchObject({ id: "oai", protocol: "openai" });
    expect(registry.resolve("m-ant")).toMatchObject({ id: "ant", protocol: "anthropic" });
    expect(registry.resolve("unlisted")).toMatchObject({ id: "default", protocol: "anthropic" });
  });
});
