// T0: the proxy's model check (ADR-0023 decision 1). The body's model must be one of the run's
// frozen models; the configured CLI small-fast id is rewritten to the run's cheap model; anything
// else, or no readable model at all, is refused.

import { describe, expect, it } from "vitest";
import { frozenModelsOf, modelVerdict } from "./frozen-models.js";

const frozen = { model: "test-model-default", cheapModel: "test-model-cheap" };

describe("modelVerdict", () => {
  it("forwards the frozen model and the frozen cheap model unchanged", () => {
    expect(modelVerdict("test-model-default", frozen)).toEqual({
      verdict: "forward",
      model: "test-model-default",
    });
    expect(modelVerdict("test-model-cheap", frozen)).toEqual({
      verdict: "forward",
      model: "test-model-cheap",
    });
  });

  it("rewrites the configured small-fast id to the cheap model and says from what", () => {
    expect(modelVerdict("cli-small-fast", frozen, "cli-small-fast")).toEqual({
      verdict: "rewrite",
      from: "cli-small-fast",
      model: "test-model-cheap",
    });
  });

  it("does not rewrite a small-fast id that is already in the frozen set", () => {
    expect(modelVerdict("test-model-default", frozen, "test-model-default")).toEqual({
      verdict: "forward",
      model: "test-model-default",
    });
  });

  it("refuses any other id, an absent id and a run with no frozen models", () => {
    expect(modelVerdict("test-model-unlisted", frozen)).toEqual({ verdict: "refuse" });
    // Without configuration there is no small-fast id: nothing is rewritten.
    expect(modelVerdict("cli-small-fast", frozen)).toEqual({ verdict: "refuse" });
    expect(modelVerdict(undefined, frozen)).toEqual({ verdict: "refuse" });
    expect(modelVerdict("", frozen, "")).toEqual({ verdict: "refuse" });
    expect(modelVerdict("test-model-default", undefined)).toEqual({ verdict: "refuse" });
  });

  it("is case- and whitespace-exact: a look-alike id is another id", () => {
    expect(modelVerdict("Test-Model-Default", frozen)).toEqual({ verdict: "refuse" });
    expect(modelVerdict(" test-model-default", frozen)).toEqual({ verdict: "refuse" });
  });
});

describe("frozenModelsOf", () => {
  it("reads the models a run was frozen on from its config", () => {
    expect(frozenModelsOf({ model: "a", cheapModel: "b", defaultModel: "x" })).toEqual({
      model: "a",
      cheapModel: "b",
    });
  });

  it("is undefined until both are frozen, so a run that never started is refused", () => {
    expect(frozenModelsOf({ defaultModel: "a", defaultCheapModel: "b" })).toBeUndefined();
    expect(frozenModelsOf({ model: "a" })).toBeUndefined();
    expect(frozenModelsOf({ model: "", cheapModel: "b" })).toBeUndefined();
  });
});

describe("the frozen fallback model (ADR-0023 decision 3)", () => {
  it("is forwarded only for a run frozen with it", () => {
    const withFallback = { ...frozen, fallbackModel: "test-model-fallback" };
    expect(modelVerdict("test-model-fallback", withFallback)).toEqual({
      verdict: "forward",
      model: "test-model-fallback",
    });
    expect(modelVerdict("test-model-fallback", frozen)).toEqual({ verdict: "refuse" });
  });

  it("is read from the run config, with null meaning none", () => {
    expect(frozenModelsOf({ model: "a", cheapModel: "b", fallbackModel: "c" })?.fallbackModel).toBe(
      "c",
    );
    expect(frozenModelsOf({ model: "a", cheapModel: "b", fallbackModel: null })).toEqual({
      model: "a",
      cheapModel: "b",
    });
  });
});
