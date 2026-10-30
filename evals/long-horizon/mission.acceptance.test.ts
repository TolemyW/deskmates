// Explicit opt-in only. No paid campaign is authorised by this suite or its environment.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  dockerAvailable,
  requireImageId,
  requireWorkspaceImageId,
} from "../../acceptance/support/docker.js";
import { modelEnv } from "../../acceptance/support/env.js";
import { type Stack, startStack } from "../../acceptance/support/start-stack.js";
import { stopStack } from "../../acceptance/support/stop-stack.js";
import { campaignConfig } from "../campaign/stack.js";
import { authoriseLongHorizon } from "./gate.js";
import { parseMission } from "./mission.js";
import { digest, reserveReport, saveReport } from "./report.js";
import { runMission } from "./runner.js";

const enabled = process.env.EVAL_CAMPAIGN === "long-horizon-v2";
describe.skipIf(!enabled)("long-horizon v2 (set EVAL_CAMPAIGN=long-horizon-v2)", () => {
  it(
    "records one declared mission attempt, retaining partial and failed outcomes",
    async () => {
      const file = resolve(
        import.meta.dirname,
        process.env.MISSION_FILE ?? "missions/lh01-overdue-sweep.json",
      );
      const specText = readFileSync(file, "utf8");
      const mission = parseMission(specText);
      const models = modelEnv();
      const settings = campaignConfig(process.env, {});
      const { repeat, arm, reportDir } = authoriseLongHorizon(
        process.env,
        [models.defaultModel, models.cheapModel],
        settings.modelPrices,
      );
      const imageId = requireWorkspaceImageId();
      const egressImageId = requireImageId(
        process.env.EGRESS_PROXY_IMAGE?.trim(),
        "EGRESS_PROXY_IMAGE",
      );
      if (!(await dockerAvailable())) throw new Error("long-horizon requires Docker");
      const reportFile = reserveReport(reportDir, `${mission.id}__${arm}__r${repeat}`, {
        campaign: "long-horizon-v2",
        missionId: mission.id,
        specSha256: digest(specText),
        imageId,
        egressImageId,
        defaultModel: models.defaultModel,
        cheapModel: models.cheapModel,
        prices: settings.modelPrices,
      });
      let stack: Stack | undefined;
      try {
        stack = await startStack({
          ...models,
          label: `lh-${repeat}`,
          botName: "mission_eval",
          shortWaitSeconds: mission.budgets.shortWaitSeconds,
          ...(mission.bot?.cron ? { cron: mission.bot.cron } : {}),
          modelPrices: settings.modelPrices,
          ...(settings.modelUpstreams
            ? { campaignConfig: { modelUpstreams: settings.modelUpstreams } }
            : {}),
        });
        const secrets = [models.modelAuthToken, stack.config.operatorToken, stack.webhookToken];
        const report = await runMission({
          mission,
          specText,
          stack,
          repeat,
          arm,
          imageId,
          egressImageId,
          persist: (partial) => saveReport(reportFile, partial, secrets),
        });
        // A negative oracle verdict is data. Infrastructure gaps fail the executor after export.
        expect(report.observerErrors).toEqual([]);
        expect(report.finishedAt).not.toBeNull();
      } finally {
        await stopStack(stack);
      }
    },
    5 * 3_600_000,
  );
});
