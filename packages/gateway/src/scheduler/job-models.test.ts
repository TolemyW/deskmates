// T0: the one enumerated list of background job kinds that run on the cheap model (ADR-0023
// decision 2). The job kind is the only input: nothing else can put a run on the cheap model here.

import { describe, expect, it } from "vitest";
import { CONSOLIDATION_RUN_TYPE } from "../memory/consolidation.js";
import { MEMORY_ORGANIZE } from "../memory/organize.js";
import { MEMORY_RECHECK } from "../memory/recheck.js";
import { ROUND_TRIAGE } from "../model-jobs/round-triage.js";
import { SOUL_PROPOSAL } from "../model-jobs/soul-proposals.js";
import { STATUS_INQUIRY } from "../model-jobs/status-inquiries.js";
import { VISION_PROBE } from "../model-jobs/vision-probes.js";
import { CHEAP_MODEL_JOB_KINDS, modelsForJob } from "./job-models.js";

describe("cheap-model job kinds", () => {
  it("lists Activity summaries, memory consolidation, organisation and recheck, round triage and SOUL proposals and nothing else", () => {
    expect(CHEAP_MODEL_JOB_KINDS).toEqual([
      "activity_summary",
      CONSOLIDATION_RUN_TYPE,
      MEMORY_ORGANIZE,
      MEMORY_RECHECK,
      ROUND_TRIAGE,
      SOUL_PROPOSAL,
    ]);
  });

  it("puts a round triage on the cheap model (ADR-0005 amendment 6, decision 45)", () => {
    expect(modelsForJob(ROUND_TRIAGE, "test-model-cheap")).toEqual({
      model: "test-model-cheap",
      cheapModel: "test-model-cheap",
    });
  });

  it("never puts a Guest status answer on the cheap model (ADR-0022 amendment 7 S1)", () => {
    expect(modelsForJob(STATUS_INQUIRY, "test-model-cheap")).toEqual({});
  });

  it("never puts a vision probe on the cheap model: it runs on the model it probes", () => {
    expect(modelsForJob(VISION_PROBE, "test-model-cheap")).toEqual({});
  });

  it("freezes both models on the cheap one for a listed kind", () => {
    expect(modelsForJob(CONSOLIDATION_RUN_TYPE, "test-model-cheap")).toEqual({
      model: "test-model-cheap",
      cheapModel: "test-model-cheap",
    });
  });

  it("adds nothing for any other kind, so the run selects as before", () => {
    for (const kind of [undefined, "", "chat", "cron", "webhook", "Memory_Consolidation"]) {
      expect(modelsForJob(kind, "test-model-cheap"), String(kind)).toEqual({});
    }
  });
});
