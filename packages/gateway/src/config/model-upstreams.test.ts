// T0: the installation model registry read from `.env` (ADR-0039 decisions 1 and 4).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { ModelRegistry, modelRegistryOf, parseModelUpstreams } from "./model-upstreams.js";

const BASE_ENV = {
  GATEWAY_OPERATOR_TOKEN: "operator-config-test-token-32-bytes-minimum",
  MODEL_BASE_URL: "http://upstream.test/",
  MODEL_AUTH_TOKEN: "upstream-secret",
  DEFAULT_MODEL: "remote-large",
  CHEAP_MODEL: "qwen3.8-27b",
};

const TOS = [
  {
    id: "tos-9b",
    baseUrl: "http://10.20.50.16:8003/",
    models: ["qwen3.5-9b"],
    protocol: "anthropic",
  },
  {
    id: "tos-27b",
    baseUrl: "http://10.20.50.16:8004",
    models: ["qwen3.8-27b"],
    protocol: "anthropic",
  },
  {
    id: "tos-vl",
    baseUrl: "http://10.20.50.16:8005",
    authToken: "vl-secret",
    models: ["qwen3.5-9b-vl"],
    protocol: "anthropic",
  },
];

describe("MODEL_UPSTREAMS (ADR-0039 decision 1)", () => {
  it("is optional: without it everything routes to the default upstream as before", () => {
    const config = loadConfig({ ...BASE_ENV, CHEAP_MODEL: "remote-small" });
    expect(config.modelUpstreams).toBeUndefined();
    const registry = new ModelRegistry(config);
    expect(registry.resolve("anything")).toEqual({
      id: "default",
      baseUrl: "http://upstream.test",
      authToken: "upstream-secret",
      protocol: "anthropic",
    });
  });

  it("routes listed models to their upstream and everything else to default", () => {
    const config = loadConfig({ ...BASE_ENV, MODEL_UPSTREAMS: JSON.stringify(TOS) });
    const registry = modelRegistryOf(config);
    expect(registry.resolve("qwen3.5-9b")).toEqual({
      id: "tos-9b",
      baseUrl: "http://10.20.50.16:8003",
      protocol: "anthropic",
    });
    expect(registry.resolve("qwen3.8-27b")?.id).toBe("tos-27b");
    expect(registry.resolve("qwen3.5-9b-vl")).toEqual({
      id: "tos-vl",
      baseUrl: "http://10.20.50.16:8005",
      authToken: "vl-secret",
      protocol: "anthropic",
    });
    expect(registry.resolve("remote-large")?.id).toBe("default");
    expect(registry.secrets().sort()).toEqual(["upstream-secret", "vl-secret"]);
  });

  it("lists registered models with upstream ids only, sorted", () => {
    const registry = new ModelRegistry(
      loadConfig({ ...BASE_ENV, MODEL_UPSTREAMS: JSON.stringify(TOS) }),
    );
    expect(registry.registered()).toEqual([
      { model: "qwen3.5-9b", upstream: "tos-9b" },
      { model: "qwen3.5-9b-vl", upstream: "tos-vl" },
      { model: "qwen3.8-27b", upstream: "tos-27b" },
      { model: "remote-large", upstream: "default" },
    ]);
  });

  it("allows an install with no default upstream; an unlisted model is then unroutable", () => {
    const config = loadConfig({
      ...BASE_ENV,
      MODEL_BASE_URL: "",
      MODEL_AUTH_TOKEN: "",
      DEFAULT_MODEL: "qwen3.5-9b",
      MODEL_UPSTREAMS: JSON.stringify(TOS),
    });
    const registry = new ModelRegistry(config);
    expect(registry.resolve("remote-large")).toBeUndefined();
    expect(registry.resolve("qwen3.5-9b")?.id).toBe("tos-9b");
    expect(registry.secrets()).toEqual(["vl-secret"]);
  });

  it("refuses a configured model no upstream serves (decision 4)", () => {
    const only = JSON.stringify(TOS);
    expect(() => loadConfig({ ...BASE_ENV, MODEL_BASE_URL: "", MODEL_UPSTREAMS: only })).toThrow(
      /DEFAULT_MODEL "remote-large" is served by no upstream/,
    );
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        MODEL_BASE_URL: "",
        DEFAULT_MODEL: "qwen3.5-9b",
        CHEAP_MODEL: "nowhere",
        MODEL_UPSTREAMS: only,
      }),
    ).toThrow(/CHEAP_MODEL/);
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        MODEL_BASE_URL: "",
        DEFAULT_MODEL: "qwen3.5-9b",
        FALLBACK_MODEL: "nowhere",
        MODEL_UPSTREAMS: only,
      }),
    ).toThrow(/FALLBACK_MODEL/);
  });

  it("keeps MODEL_BASE_URL and MODEL_AUTH_TOKEN required without upstreams", () => {
    expect(() => loadConfig({ ...BASE_ENV, MODEL_BASE_URL: "" })).toThrow(/MODEL_BASE_URL/);
    expect(() => loadConfig({ ...BASE_ENV, MODEL_AUTH_TOKEN: "" })).toThrow(/MODEL_AUTH_TOKEN/);
    expect(() =>
      loadConfig({ ...BASE_ENV, MODEL_AUTH_TOKEN: "", MODEL_UPSTREAMS: JSON.stringify(TOS) }),
    ).toThrow(/MODEL_AUTH_TOKEN/);
  });

  it("fails startup on every malformed entry", () => {
    const one = (patch: Record<string, unknown>) =>
      JSON.stringify([
        { id: "a", baseUrl: "http://a.test", models: ["m"], protocol: "anthropic", ...patch },
      ]);
    const bad: [string, RegExp][] = [
      ["not json", /not valid JSON/],
      ['{"id":"a"}', /JSON array/],
      ["[1]", /must be an object/],
      [one({ id: "Bad_Id" }), /id must match/],
      [one({ id: "default" }), /reserved/],
      [one({ baseUrl: "" }), /needs a baseUrl/],
      [one({ baseUrl: "ftp://a.test" }), /http or https/],
      [one({ baseUrl: "http://user:pw@a.test" }), /must not carry credentials/],
      [one({ authToken: "" }), /authToken/],
      [one({ protocol: "gemini" }), /protocol must be one of anthropic, openai/],
      [one({ protocol: undefined }), /protocol/],
      [one({ models: [] }), /at least one model/],
      [one({ models: [" m"] }), /not a non-empty string/],
      [one({ extra: 1 }), /unknown key "extra"/],
      [
        JSON.stringify([
          { id: "a", baseUrl: "http://a.test", models: ["m"], protocol: "anthropic" },
          { id: "a", baseUrl: "http://b.test", models: ["n"], protocol: "anthropic" },
        ]),
        /duplicate upstream id "a"/,
      ],
      [
        JSON.stringify([
          { id: "a", baseUrl: "http://a.test", models: ["m"], protocol: "anthropic" },
          { id: "b", baseUrl: "http://b.test", models: ["m"], protocol: "anthropic" },
        ]),
        /model "m" is listed by both "a" and "b"/,
      ],
    ];
    for (const [raw, message] of bad) {
      expect(() => parseModelUpstreams(raw), raw).toThrow(message);
      expect(() => loadConfig({ ...BASE_ENV, MODEL_UPSTREAMS: raw }), raw).toThrow(
        /MODEL_UPSTREAMS/,
      );
    }
    expect(parseModelUpstreams("  ")).toEqual([]);
  });

  it("is documented in .env.example", () => {
    const example = readFileSync(new URL("../../../../.env.example", import.meta.url), "utf8");
    expect(example).toMatch(/^MODEL_UPSTREAMS=$/m);
  });
});
