// T0, issue #39 item 8: the model-job knobs of the run domain. MODEL_JOB_DEADLINE_MS keeps
// ADR-0023 amendment 1's default of 55 s; MODEL_JOB_THINKING is `disabled` unless set to
// `sdk-default`; both are documented in .env.example and a typo stops startup.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MODEL_JOB_DEADLINE_MS_DEFAULT, MODEL_JOB_KILL_GRACE_MS, readRunsConfig } from "./runs.js";

describe("model job knobs (issue #39 item 8)", () => {
  it("defaults to a 55 s deadline killed at 60 s, and thinking disabled", () => {
    const config = readRunsConfig({});
    expect(MODEL_JOB_DEADLINE_MS_DEFAULT).toBe(55_000);
    expect(MODEL_JOB_DEADLINE_MS_DEFAULT + MODEL_JOB_KILL_GRACE_MS).toBe(60_000);
    expect(config.modelJobDeadlineMs).toBe(55_000);
    expect(config.modelJobThinking).toBe("disabled");
    expect(readRunsConfig({ MODEL_JOB_DEADLINE_MS: "", MODEL_JOB_THINKING: "" })).toMatchObject({
      modelJobDeadlineMs: 55_000,
      modelJobThinking: "disabled",
    });
  });

  it("reads both from the environment and refuses a bad value", () => {
    expect(
      readRunsConfig({ MODEL_JOB_DEADLINE_MS: "90000", MODEL_JOB_THINKING: "sdk-default" }),
    ).toMatchObject({ modelJobDeadlineMs: 90_000, modelJobThinking: "sdk-default" });
    for (const raw of ["0", "-5", "soon"])
      expect(() => readRunsConfig({ MODEL_JOB_DEADLINE_MS: raw }), raw).toThrow(
        /MODEL_JOB_DEADLINE_MS/,
      );
    expect(() => readRunsConfig({ MODEL_JOB_THINKING: "adaptive" })).toThrow(/MODEL_JOB_THINKING/);
  });

  it("documents both in .env.example", () => {
    const example = readFileSync(
      fileURLToPath(new URL("../../../../.env.example", import.meta.url)),
      "utf8",
    );
    for (const key of ["MODEL_JOB_DEADLINE_MS", "MODEL_JOB_THINKING"])
      expect(example).toMatch(new RegExp(`^${key}=\\s`, "m"));
  });
});
