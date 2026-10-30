import type { ModelPrice } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { authoriseLongHorizon } from "./gate.js";
const env = {
  EVAL_CAMPAIGN: "long-horizon-v2",
  EVAL_REPEAT: "1",
  EVAL_ARM: "baseline",
  EVAL_REPORT_DIR: "/tmp/private-long-horizon",
};
const zero: ModelPrice = {
  model: "test-zero",
  inputPerM: 0,
  outputPerM: 0,
  cacheReadPerM: 0,
  cacheCreatePerM: 0,
  effectiveFrom: "2026-10-19T00:00:00.000Z",
};
describe("long-horizon execution gate", () => {
  it("requires an explicit campaign and one predeclared repeat", () => {
    expect(() => authoriseLongHorizon({}, [zero.model], [zero])).toThrow("not enabled");
    expect(() =>
      authoriseLongHorizon({ ...env, EVAL_REPEAT: "1.5" }, [zero.model], [zero]),
    ).toThrow("EVAL_REPEAT");
    expect(authoriseLongHorizon(env, [zero.model], [zero])).toMatchObject({
      repeat: 1,
      arm: "baseline",
    });
  });
  it("rejects unknown price and a paid model even with a numeric ceiling", () => {
    expect(() => authoriseLongHorizon(env, [zero.model], [])).toThrow("no MODEL_PRICES");
    expect(() =>
      authoriseLongHorizon(
        { ...env, EVAL_CEILING_USD: "999" },
        [zero.model],
        [{ ...zero, inputPerM: 1 }],
      ),
    ).toThrow("only known-zero");
  });
});
