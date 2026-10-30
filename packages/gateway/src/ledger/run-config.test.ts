// T0 (ADR-0041 decision 9): a run records the retrieval it used, and only where it is configured,
// so earlier and unconfigured run rows stay comparable.

import { expect, it } from "vitest";
import { RETRIEVAL_DEFAULTS } from "../config/retrieval.js";
import { testConfig } from "../test-support/harness.js";
import { createRunConfig } from "./run-config.js";

it("records the accepted multi-number memory policy on new runs", () => {
  expect(createRunConfig(testConfig())().memoryValuePolicy).toBe("multi-number-body-v1");
});

it("stamps retrieval knobs only when hybrid retrieval is configured", () => {
  expect("retrieval" in createRunConfig(testConfig())()).toBe(false);
  const knobs = createRunConfig(
    testConfig({
      retrieval: {
        embedding: { url: "http://e.test/api/embed", model: "embed-model" },
        ...RETRIEVAL_DEFAULTS,
      },
    }),
  )().retrieval;
  expect(knobs).toEqual({
    version: 1,
    embeddingModel: "embed-model",
    candidates: 50,
    rrfK: 60,
    rerankTopN: 20,
    minSimilarity: 0.45,
    chunkVersion: 1,
    chunkCharacters: 1200,
    chunkOverlap: 200,
  });
});

it("records the owner-requested research strategy on new runs", () => {
  expect(createRunConfig(testConfig())().researchGuidance).toBe("verify-v1");
});
