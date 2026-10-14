// T0: reading SDK 0.3.278's untyped overload-fallback message and recording a switch once per turn
// (ADR-0023 decision 3). The run-level behaviour is T1 in `model-events.test.ts`.

import type { ModelSwitchPayload } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { ModelSwitchRecorder, fallbackSwitch, isModelFallbackMessage } from "./model-switch.js";

const observed = {
  type: "system",
  subtype: "model_fallback",
  uuid: "d038392a-8d8f-43ed-971e-6600fae3369f",
  trigger: "overloaded",
  original_model: "spike-primary",
  fallback_model: "spike-fallback",
  content: "Switched to spike-fallback due to high demand for spike-primary",
  session_id: "998bb398-08fa-434e-b4d3-2750a7b98292",
};

describe("isModelFallbackMessage", () => {
  it("accepts the message as SDK 0.3.278 sent it and maps it to an auto switch", () => {
    expect(isModelFallbackMessage(observed)).toBe(true);
    if (!isModelFallbackMessage(observed)) return;
    expect(fallbackSwitch(observed)).toEqual({
      from: "spike-primary",
      to: "spike-fallback",
      source: "auto",
    });
  });

  it("refuses anything else", () => {
    for (const msg of [
      null,
      "model_fallback",
      { ...observed, type: "assistant" },
      { ...observed, subtype: "api_retry" },
      { ...observed, original_model: "" },
      { ...observed, fallback_model: 7 },
      { type: "system", subtype: "model_fallback" },
    ]) {
      expect(isModelFallbackMessage(msg), JSON.stringify(msg)).toBe(false);
    }
  });
});

describe("ModelSwitchRecorder", () => {
  it("records a pair once per turn and again after a new model response", () => {
    const emitted: ModelSwitchPayload[] = [];
    const recorder = new ModelSwitchRecorder((p) => emitted.push(p));
    const ab: ModelSwitchPayload = { from: "a", to: "b", source: "auto" };
    recorder.observeAssistant("msg_1");
    recorder.record(ab);
    recorder.record({ ...ab, requested: "b" });
    recorder.observeAssistant("msg_1");
    recorder.record(ab);
    recorder.record({ from: "b", to: "a", source: "sdk" });
    recorder.observeAssistant("msg_2");
    recorder.record(ab);
    expect(emitted.map((p) => `${p.from}->${p.to}`)).toEqual(["a->b", "b->a", "a->b"]);
  });
});
