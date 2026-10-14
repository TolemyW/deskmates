// T3: M0 acceptance `acceptance/m0-model-swap` (test strategy §7): the same task (deskbench
// S01) with only DEFAULT_MODEL changed. Two stacks are started one after the other, identical
// except that the second one's DEFAULT_MODEL is the .env CHEAP_MODEL; the bot's `model` stays
// unset in both, so the swap is the deployment configuration, exactly as an operator would edit
// `.env`. Both runs must succeed with the right answer, and `run_usage.model` must name the model
// each stack was configured with. Needs the four model variables and Docker; skips by name.

import { afterEach, describe, expect, it } from "vitest";
import { dockerAvailable } from "./support/docker.js";
import { missingModelEnv, modelEnv, skipReason } from "./support/env.js";
import { getRun } from "./support/runs.js";
import { type S01Result, runS01 } from "./support/s01.js";
import { type Stack, startStack } from "./support/start-stack.js";
import { stopStack } from "./support/stop-stack.js";

const missing = missingModelEnv();
const dockerUp = await dockerAvailable();
const skip = missing.length > 0 || !dockerUp;
if (skip) {
  console.warn(`[m0-model-swap.acceptance.test]${skipReason(missing, dockerUp)}`);
}

interface Attempt {
  model: string;
  result: S01Result;
  usageModels: string[];
  configModel: unknown;
}

describe.skipIf(skip)(
  `M0 model swap (T3): S01 on DEFAULT_MODEL, then on CHEAP_MODEL${skipReason(missing, dockerUp)}`,
  () => {
    let stack: Stack | undefined;
    const attempts: Attempt[] = [];

    afterEach(async () => {
      await stopStack(stack);
      stack = undefined;
    }, 120_000);

    async function attempt(label: string, model: string): Promise<Attempt> {
      const env = modelEnv();
      stack = await startStack({ ...env, defaultModel: model, label });
      const result = await runS01(stack);
      console.log(
        `[model-swap] ${model}: ${result.run.status} in ${Math.round(result.wallClockMs / 1000)}s; answer=${result.answer}`,
      );
      const { usage } = await getRun(stack, result.run.id);
      const a: Attempt = {
        model,
        result,
        usageModels: usage.map((u) => u.model),
        configModel: result.run.config.defaultModel,
      };
      attempts.push(a);
      expect(result.run.status, result.run.error).toBe("succeeded");
      expect(result.loggedIn).toBe(true);
      expect(result.answer, `reply had no answer line: ${result.reply}`).toBe(result.expected);
      expect(a.configModel).toBe(model);
      expect(usage.length).toBeGreaterThanOrEqual(1);
      expect(a.usageModels).toContain(model);
      return a;
    }

    it(
      "S01 passes on DEFAULT_MODEL",
      async () => {
        await attempt("swap-default", modelEnv().defaultModel);
      },
      25 * 60_000,
    );

    it(
      "S01 passes on CHEAP_MODEL with nothing else changed",
      async () => {
        await attempt("swap-cheap", modelEnv().cheapModel);
      },
      25 * 60_000,
    );

    it("run_usage.model differs between the two runs and follows the configuration", () => {
      expect(attempts).toHaveLength(2);
      const [first, second] = attempts as [Attempt, Attempt];
      const env = modelEnv();
      expect(env.defaultModel).not.toBe(env.cheapModel);
      expect(first.usageModels).toContain(env.defaultModel);
      expect(second.usageModels).toContain(env.cheapModel);
      // The CLI may add a small side-call model of its own (see m0-stack: session title
      // generation), so the sets are compared, not pinned to exactly one row each.
      expect(first.usageModels.sort()).not.toEqual(second.usageModels.sort());
      expect(first.configModel).not.toBe(second.configModel);
    });
  },
);
